//! RFC 3161 time-stamp token verification for ledger anchors (`ledger.chain_anchor.tst`, Architecture.md §10).
//!
//! [`verify_timestamp_token`] answers one question: *did a trusted time-stamping authority sign a token binding
//! exactly this 32-byte chain-head hash to a time?* It checks, in order:
//!
//! 1. the token is a CMS `SignedData` carrying a `TSTInfo` (RFC 3161 §2.4.2) with exactly one `SignerInfo`;
//! 2. the `TSTInfo` message imprint is SHA-256 over the expected hash;
//! 3. the CMS `messageDigest` attribute equals the digest of the `TSTInfo`, and the signature over the signed
//!    attributes verifies under the signer certificate (RSA PKCS#1 v1.5 with SHA-256/384/512, ECDSA P-256/SHA-256,
//!    ECDSA P-384/SHA-384);
//! 4. the signer certificate is valid at `genTime`, carries a **critical** `id-kp-timeStamping` extended key usage
//!    (RFC 3161 §2.3), and chains (embedded intermediates, each a CA, each valid at `genTime`) to one of the trusted
//!    certificates the caller supplies.
//!
//! Not implemented (stated, not hidden): revocation checking (OCSP/CRL), RSASSA-PSS and EdDSA signatures,
//! name/policy constraints, and the EU Trusted List lookup that decides which certificates are *qualified*
//! (Progress.md Phase 3, decision D-7). BER (indefinite-length) encodings are rejected: tokens must be DER.
//! The DER walker below is deliberately tiny and fails closed on anything it does not understand.

use ring::{digest, signature};
use x509_cert::Certificate;
use x509_cert::der::asn1::{GeneralizedTime, ObjectIdentifier};
use x509_cert::der::{Decode, Encode};
use x509_cert::ext::pkix::{BasicConstraints, ExtendedKeyUsage, SubjectKeyIdentifier};

use crate::Hash;

/// Why a token was rejected.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AnchorError {
    /// Structurally invalid or unsupported encoding.
    #[error("malformed time-stamp token: {0}")]
    Malformed(&'static str),
    /// The TSA refused the request (`PKIStatus` not granted).
    #[error("time-stamp response status {0} is not granted")]
    NotGranted(i64),
    /// Valid token, but not over the expected hash.
    #[error("token message imprint does not match the expected chain-head hash")]
    HashMismatch,
    /// The signed attributes do not commit to the `TSTInfo` that is inside the token.
    #[error("signed message digest does not match the TSTInfo")]
    DigestMismatch,
    /// The signature does not verify under the signer certificate.
    #[error("signature verification failed")]
    BadSignature,
    /// An algorithm used by the token is not supported by this verifier.
    #[error("unsupported algorithm: {0}")]
    UnsupportedAlgorithm(String),
    /// The signer certificate named by the token is not among the embedded certificates.
    #[error("signer certificate not found in token")]
    SignerNotFound,
    /// The signer does not chain to a trusted certificate.
    #[error("signer certificate does not chain to a trusted certificate")]
    UntrustedSigner,
    /// A certificate on the path is not valid at the token's `genTime`.
    #[error("certificate not valid at genTime")]
    NotValidAtGenTime,
    /// The signer certificate lacks a critical `id-kp-timeStamping` extended key usage.
    #[error("signer certificate is not a (critical) time-stamping certificate")]
    NotATimestampingCertificate,
    /// An issuer on the path is not a CA.
    #[error("issuer certificate is not a CA")]
    IssuerNotCa,
}

/// What a verified token proves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimestampInfo {
    /// `genTime` as seconds since the Unix epoch (UTC).
    pub gen_time_unix: i64,
    /// TSA policy OID, dotted.
    pub policy: String,
    /// TSA-assigned serial number, hex (leading zeros stripped).
    pub serial_hex: String,
    /// Serial number of the signer certificate, hex.
    pub signer_serial_hex: String,
}

// ---------------------------------------------------------------- minimal strict DER reader

#[derive(Clone, Copy)]
struct Tlv<'a> {
    tag: u8,
    raw: &'a [u8],
    content: &'a [u8],
}

impl<'a> Tlv<'a> {
    /// Read one TLV from the front of `input`; returns it and the remainder.
    fn read(input: &'a [u8]) -> Result<(Self, &'a [u8]), AnchorError> {
        let (&tag, rest) = input
            .split_first()
            .ok_or(AnchorError::Malformed("truncated"))?;
        if tag & 0x1f == 0x1f {
            return Err(AnchorError::Malformed("high tag numbers are not supported"));
        }
        let (&l0, rest) = rest
            .split_first()
            .ok_or(AnchorError::Malformed("truncated"))?;
        let (len, rest) = if l0 < 0x80 {
            (usize::from(l0), rest)
        } else if l0 == 0x80 {
            return Err(AnchorError::Malformed(
                "indefinite length (BER) is not supported",
            ));
        } else {
            let n = usize::from(l0 & 0x7f);
            if n > 4 || rest.len() < n {
                return Err(AnchorError::Malformed("bad length"));
            }
            let (len_bytes, rest) = rest.split_at(n);
            let len = len_bytes
                .iter()
                .fold(0usize, |acc, b| (acc << 8) | usize::from(*b));
            (len, rest)
        };
        if rest.len() < len {
            return Err(AnchorError::Malformed("length exceeds input"));
        }
        let (content, tail) = rest.split_at(len);
        let consumed = input.len() - tail.len();
        let raw = input
            .get(..consumed)
            .ok_or(AnchorError::Malformed("truncated"))?;
        Ok((Tlv { tag, raw, content }, tail))
    }

    /// Parse a complete input that must be exactly one TLV.
    fn read_exact(input: &'a [u8]) -> Result<Self, AnchorError> {
        let (t, rest) = Self::read(input)?;
        if rest.is_empty() {
            Ok(t)
        } else {
            Err(AnchorError::Malformed("trailing bytes"))
        }
    }

    fn children(&self) -> Result<Vec<Tlv<'a>>, AnchorError> {
        let mut out = Vec::new();
        let mut rest = self.content;
        while !rest.is_empty() {
            let (t, tail) = Self::read(rest)?;
            out.push(t);
            rest = tail;
        }
        Ok(out)
    }

    fn expect(self, tag: u8, what: &'static str) -> Result<Self, AnchorError> {
        if self.tag == tag {
            Ok(self)
        } else {
            Err(AnchorError::Malformed(what))
        }
    }
}

const TAG_INTEGER: u8 = 0x02;
const TAG_OCTET_STRING: u8 = 0x04;
const TAG_OID: u8 = 0x06;
const TAG_GENERALIZED_TIME: u8 = 0x18;
const TAG_SEQUENCE: u8 = 0x30;
const TAG_SET: u8 = 0x31;
const TAG_CTX0_CONSTRUCTED: u8 = 0xA0;
const TAG_CTX0_PRIMITIVE: u8 = 0x80;

// DER contents of the OIDs used (value bytes without tag/length).
const OID_SIGNED_DATA: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02];
const OID_CT_TST_INFO: &[u8] = &[
    0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x10, 0x01, 0x04,
];
const OID_ATTR_CONTENT_TYPE: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x03];
const OID_ATTR_MESSAGE_DIGEST: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x04];
const OID_SHA256: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const OID_SHA384: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02];
const OID_SHA512: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03];
const OID_ECDSA_SHA256: &[u8] = &[0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02];
const OID_ECDSA_SHA384: &[u8] = &[0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x03];
const OID_EC_PUBLIC_KEY: &[u8] = &[0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01];
const OID_RSA_ENCRYPTION: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01];
const OID_RSA_SHA256: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B];
const OID_RSA_SHA384: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0C];
const OID_RSA_SHA512: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0D];
const OID_KP_TIME_STAMPING: &[u8] = &[0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x08];

fn oid_text(content: &[u8]) -> String {
    ObjectIdentifier::from_bytes(content)
        .map(|o| o.to_string())
        .unwrap_or_else(|_| "<invalid OID>".to_owned())
}

/// First child of an `AlgorithmIdentifier` SEQUENCE: the OID content bytes.
fn alg_oid<'a>(alg: Tlv<'a>) -> Result<&'a [u8], AnchorError> {
    let alg = alg.expect(TAG_SEQUENCE, "AlgorithmIdentifier is not a SEQUENCE")?;
    let kids = alg.children()?;
    let oid = kids
        .first()
        .ok_or(AnchorError::Malformed("empty AlgorithmIdentifier"))?
        .expect(TAG_OID, "algorithm is not an OID")?;
    Ok(oid.content)
}

fn digest_algorithm(oid: &[u8]) -> Result<&'static digest::Algorithm, AnchorError> {
    if oid == OID_SHA256 {
        Ok(&digest::SHA256)
    } else if oid == OID_SHA384 {
        Ok(&digest::SHA384)
    } else if oid == OID_SHA512 {
        Ok(&digest::SHA512)
    } else {
        Err(AnchorError::UnsupportedAlgorithm(oid_text(oid)))
    }
}

/// Map (signature algorithm OID, digest algorithm OID) to a verification algorithm.
fn verification_algorithm(
    sig_oid: &[u8],
    digest_oid: &[u8],
) -> Result<&'static dyn signature::VerificationAlgorithm, AnchorError> {
    let unsupported = || AnchorError::UnsupportedAlgorithm(oid_text(sig_oid));
    // "bare" key algorithms (id-ecPublicKey, rsaEncryption) take the hash from the digest algorithm
    let effective = if sig_oid == OID_EC_PUBLIC_KEY {
        if digest_oid == OID_SHA256 {
            OID_ECDSA_SHA256
        } else if digest_oid == OID_SHA384 {
            OID_ECDSA_SHA384
        } else {
            return Err(unsupported());
        }
    } else if sig_oid == OID_RSA_ENCRYPTION {
        if digest_oid == OID_SHA256 {
            OID_RSA_SHA256
        } else if digest_oid == OID_SHA384 {
            OID_RSA_SHA384
        } else if digest_oid == OID_SHA512 {
            OID_RSA_SHA512
        } else {
            return Err(unsupported());
        }
    } else {
        sig_oid
    };
    if effective == OID_ECDSA_SHA256 {
        Ok(&signature::ECDSA_P256_SHA256_ASN1)
    } else if effective == OID_ECDSA_SHA384 {
        Ok(&signature::ECDSA_P384_SHA384_ASN1)
    } else if effective == OID_RSA_SHA256 {
        Ok(&signature::RSA_PKCS1_2048_8192_SHA256)
    } else if effective == OID_RSA_SHA384 {
        Ok(&signature::RSA_PKCS1_2048_8192_SHA384)
    } else if effective == OID_RSA_SHA512 {
        Ok(&signature::RSA_PKCS1_2048_8192_SHA512)
    } else {
        Err(unsupported())
    }
}

fn verify_signature(
    sig_oid: &[u8],
    digest_oid: &[u8],
    public_key: &[u8],
    message: &[u8],
    sig: &[u8],
) -> Result<(), AnchorError> {
    let alg = verification_algorithm(sig_oid, digest_oid)?;
    signature::UnparsedPublicKey::new(alg, public_key)
        .verify(message, sig)
        .map_err(|_| AnchorError::BadSignature)
}

/// Digest algorithm implied by an X.509 `signatureAlgorithm` OID (for certificate signatures).
fn cert_digest_oid(sig_oid: &[u8]) -> &'static [u8] {
    if sig_oid == OID_ECDSA_SHA384 || sig_oid == OID_RSA_SHA384 {
        OID_SHA384
    } else if sig_oid == OID_RSA_SHA512 {
        OID_SHA512
    } else {
        OID_SHA256
    }
}

// ---------------------------------------------------------------- certificates

struct Cert<'a> {
    der: &'a [u8],
    tbs_raw: &'a [u8],
    parsed: Certificate,
    subject_der: Vec<u8>,
    issuer_der: Vec<u8>,
}

impl<'a> Cert<'a> {
    fn parse(der: &'a [u8]) -> Result<Self, AnchorError> {
        let parsed = Certificate::from_der(der)
            .map_err(|_| AnchorError::Malformed("unparseable X.509 certificate"))?;
        let outer = Tlv::read_exact(der)?.expect(TAG_SEQUENCE, "certificate is not a SEQUENCE")?;
        let tbs_raw = outer
            .children()?
            .first()
            .ok_or(AnchorError::Malformed("certificate without TBS"))?
            .raw;
        let tbs = parsed.tbs_certificate();
        let subject_der = tbs
            .subject()
            .to_der()
            .map_err(|_| AnchorError::Malformed("bad subject"))?;
        let issuer_der = tbs
            .issuer()
            .to_der()
            .map_err(|_| AnchorError::Malformed("bad issuer"))?;
        Ok(Self {
            der,
            tbs_raw,
            parsed,
            subject_der,
            issuer_der,
        })
    }

    fn public_key(&self) -> &[u8] {
        self.parsed
            .tbs_certificate()
            .subject_public_key_info()
            .subject_public_key
            .raw_bytes()
    }

    fn serial(&self) -> &[u8] {
        strip_leading_zeros(self.parsed.tbs_certificate().serial_number().as_bytes())
    }

    fn valid_at(&self, unix: u64) -> bool {
        let v = self.parsed.tbs_certificate().validity();
        v.not_before.to_unix_duration().as_secs() <= unix
            && unix <= v.not_after.to_unix_duration().as_secs()
    }

    fn is_ca(&self) -> Result<bool, AnchorError> {
        let ext = self
            .parsed
            .tbs_certificate()
            .get_extension::<BasicConstraints>()
            .map_err(|_| AnchorError::Malformed("bad basicConstraints"))?;
        Ok(ext.is_some_and(|(_, bc)| bc.ca))
    }

    /// Does `issuer` sign this certificate?
    fn signed_by(&self, issuer: &Cert<'_>) -> bool {
        if self.issuer_der != issuer.subject_der {
            return false;
        }
        let sig_oid = self.parsed.signature_algorithm().oid.as_bytes();
        let Some(sig) = self.parsed.signature().as_bytes() else {
            return false;
        };
        verify_signature(
            sig_oid,
            cert_digest_oid(sig_oid),
            issuer.public_key(),
            self.tbs_raw,
            sig,
        )
        .is_ok()
    }
}

fn strip_leading_zeros(b: &[u8]) -> &[u8] {
    let n = b.iter().take_while(|x| **x == 0).count();
    b.get(n..).unwrap_or(&[])
}

/// Walk from `signer` through embedded intermediates to a trusted certificate.
fn check_chain(
    signer: &Cert<'_>,
    embedded: &[Cert<'_>],
    trusted: &[Cert<'_>],
    gen_time: u64,
) -> Result<(), AnchorError> {
    let mut current = signer;
    for _ in 0..6 {
        if !current.valid_at(gen_time) {
            return Err(AnchorError::NotValidAtGenTime);
        }
        if trusted.iter().any(|t| t.der == current.der) {
            return Ok(());
        }
        let issuer = trusted
            .iter()
            .chain(embedded.iter())
            // a certificate never vouches for itself: self-signed certificates are trusted only by exact match above
            .find(|c| c.der != current.der && current.signed_by(c))
            .ok_or(AnchorError::UntrustedSigner)?;
        if !issuer.is_ca()? {
            return Err(AnchorError::IssuerNotCa);
        }
        current = issuer;
    }
    Err(AnchorError::UntrustedSigner)
}

fn check_timestamping_eku(signer: &Cert<'_>) -> Result<(), AnchorError> {
    let ext = signer
        .parsed
        .tbs_certificate()
        .get_extension::<ExtendedKeyUsage>()
        .map_err(|_| AnchorError::Malformed("bad extendedKeyUsage"))?;
    match ext {
        Some((true, eku)) if eku.0.iter().any(|o| o.as_bytes() == OID_KP_TIME_STAMPING) => Ok(()),
        _ => Err(AnchorError::NotATimestampingCertificate),
    }
}

// ---------------------------------------------------------------- response / token

/// Extract the `TimeStampToken` (a CMS `ContentInfo`) from a DER `TimeStampResp`, requiring status
/// `granted` (0) or `grantedWithMods` (1). The anchor table stores the token, not the response.
pub fn token_from_response(response: &[u8]) -> Result<&[u8], AnchorError> {
    let outer =
        Tlv::read_exact(response)?.expect(TAG_SEQUENCE, "TimeStampResp is not a SEQUENCE")?;
    let kids = outer.children()?;
    let status_info = kids
        .first()
        .ok_or(AnchorError::Malformed("missing PKIStatusInfo"))?
        .expect(TAG_SEQUENCE, "PKIStatusInfo is not a SEQUENCE")?;
    let status = status_info
        .children()?
        .first()
        .ok_or(AnchorError::Malformed("missing PKIStatus"))?
        .expect(TAG_INTEGER, "PKIStatus is not an INTEGER")?;
    let status_value = match status.content {
        [b] => i64::from(*b),
        _ => return Err(AnchorError::Malformed("unexpected PKIStatus encoding")),
    };
    if status_value > 1 {
        return Err(AnchorError::NotGranted(status_value));
    }
    Ok(kids
        .get(1)
        .ok_or(AnchorError::Malformed("granted response without token"))?
        .raw)
}

/// Verify an RFC 3161 `TimeStampToken` (DER) over `expected_hash` against `trusted` certificates (DER).
/// See the module documentation for exactly what is and is not checked.
pub fn verify_timestamp_token(
    token: &[u8],
    expected_hash: &Hash,
    trusted: &[&[u8]],
) -> Result<TimestampInfo, AnchorError> {
    // ContentInfo { contentType = signedData, content [0] EXPLICIT SignedData }
    let content_info =
        Tlv::read_exact(token)?.expect(TAG_SEQUENCE, "ContentInfo is not a SEQUENCE")?;
    let ci = content_info.children()?;
    let (ct, explicit) = match ci.as_slice() {
        [ct, explicit] => (*ct, *explicit),
        _ => return Err(AnchorError::Malformed("ContentInfo shape")),
    };
    if ct.expect(TAG_OID, "contentType")?.content != OID_SIGNED_DATA {
        return Err(AnchorError::Malformed("token is not CMS SignedData"));
    }
    let signed_data = Tlv::read_exact(
        explicit
            .expect(TAG_CTX0_CONSTRUCTED, "SignedData wrapper")?
            .content,
    )?
    .expect(TAG_SEQUENCE, "SignedData is not a SEQUENCE")?;

    // SignedData: version, digestAlgorithms SET, encapContentInfo, [0] certificates?, [1] crls?, signerInfos SET
    let sd = signed_data.children()?;
    let mut it = sd.iter().copied();
    it.next()
        .ok_or(AnchorError::Malformed("SignedData version"))?
        .expect(TAG_INTEGER, "SignedData version")?;
    it.next()
        .ok_or(AnchorError::Malformed("digestAlgorithms"))?
        .expect(TAG_SET, "digestAlgorithms")?;
    let encap = it
        .next()
        .ok_or(AnchorError::Malformed("encapContentInfo"))?
        .expect(TAG_SEQUENCE, "encapContentInfo")?;
    let mut cert_set: Option<Tlv<'_>> = None;
    let mut signer_infos: Option<Tlv<'_>> = None;
    for t in it {
        match t.tag {
            TAG_CTX0_CONSTRUCTED if cert_set.is_none() && signer_infos.is_none() => {
                cert_set = Some(t);
            }
            0xA1 if signer_infos.is_none() => {} // crls: ignored
            TAG_SET if signer_infos.is_none() => signer_infos = Some(t),
            _ => return Err(AnchorError::Malformed("unexpected SignedData element")),
        }
    }
    let signer_infos = signer_infos
        .ok_or(AnchorError::Malformed("signerInfos"))?
        .children()?;
    let [signer_info] = signer_infos.as_slice() else {
        return Err(AnchorError::Malformed("exactly one SignerInfo is required"));
    };

    // encapContentInfo { eContentType = id-ct-TSTInfo, [0] EXPLICIT OCTET STRING }
    let enc = encap.children()?;
    let (e_type, e_content) = match enc.as_slice() {
        [t, c] => (*t, *c),
        _ => return Err(AnchorError::Malformed("encapContentInfo shape")),
    };
    if e_type.expect(TAG_OID, "eContentType")?.content != OID_CT_TST_INFO {
        return Err(AnchorError::Malformed("token does not carry a TSTInfo"));
    }
    let tst_info_der = Tlv::read_exact(
        e_content
            .expect(TAG_CTX0_CONSTRUCTED, "eContent wrapper")?
            .content,
    )?
    .expect(TAG_OCTET_STRING, "eContent is not a primitive OCTET STRING")?
    .content;

    // TSTInfo: version, policy, messageImprint, serialNumber, genTime, ...
    let tst = Tlv::read_exact(tst_info_der)?.expect(TAG_SEQUENCE, "TSTInfo is not a SEQUENCE")?;
    let tk = tst.children()?;
    let (policy, imprint, serial, gen_time) = match tk.as_slice() {
        [_version, policy, imprint, serial, gen_time, ..] => {
            (*policy, *imprint, *serial, *gen_time)
        }
        _ => return Err(AnchorError::Malformed("TSTInfo shape")),
    };
    let policy = policy.expect(TAG_OID, "TSTInfo policy")?;
    let serial = serial.expect(TAG_INTEGER, "TSTInfo serialNumber")?;
    let imprint = imprint.expect(TAG_SEQUENCE, "messageImprint")?.children()?;
    let (imprint_alg, imprint_hash) = match imprint.as_slice() {
        [a, h] => (*a, *h),
        _ => return Err(AnchorError::Malformed("messageImprint shape")),
    };
    let imprint_hash = imprint_hash.expect(TAG_OCTET_STRING, "hashedMessage")?;
    if alg_oid(imprint_alg)? != OID_SHA256 {
        return Err(AnchorError::UnsupportedAlgorithm(oid_text(alg_oid(
            imprint_alg,
        )?)));
    }
    let gen_time = GeneralizedTime::from_der(gen_time.expect(TAG_GENERALIZED_TIME, "genTime")?.raw)
        .map_err(|_| AnchorError::Malformed("genTime"))?
        .to_unix_duration()
        .as_secs();

    // SignerInfo: version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature, [1] unsignedAttrs?
    let si = signer_info.expect(TAG_SEQUENCE, "SignerInfo")?.children()?;
    let mut sit = si.iter().copied();
    sit.next()
        .ok_or(AnchorError::Malformed("SignerInfo version"))?
        .expect(TAG_INTEGER, "SignerInfo version")?;
    let sid = sit.next().ok_or(AnchorError::Malformed("sid"))?;
    let digest_alg = sit
        .next()
        .ok_or(AnchorError::Malformed("SignerInfo digestAlgorithm"))?;
    let signed_attrs = sit
        .next()
        .ok_or(AnchorError::Malformed("signedAttrs"))?
        .expect(TAG_CTX0_CONSTRUCTED, "signedAttrs are required")?;
    let sig_alg = sit
        .next()
        .ok_or(AnchorError::Malformed("signatureAlgorithm"))?;
    let signature_value = sit
        .next()
        .ok_or(AnchorError::Malformed("signature"))?
        .expect(TAG_OCTET_STRING, "signature")?
        .content;
    let digest_oid = alg_oid(digest_alg)?;
    let sig_oid = alg_oid(sig_alg)?;

    // signed attributes: contentType == id-ct-TSTInfo and messageDigest == H(TSTInfo), each exactly once
    let mut content_type: Option<&[u8]> = None;
    let mut message_digest: Option<&[u8]> = None;
    for attr in signed_attrs.children()? {
        let parts = attr.expect(TAG_SEQUENCE, "attribute")?.children()?;
        let (oid, values) = match parts.as_slice() {
            [oid, values] => (*oid, *values),
            _ => return Err(AnchorError::Malformed("attribute shape")),
        };
        let oid = oid.expect(TAG_OID, "attribute type")?.content;
        let vals = values.expect(TAG_SET, "attribute values")?.children()?;
        let slot = if oid == OID_ATTR_CONTENT_TYPE {
            &mut content_type
        } else if oid == OID_ATTR_MESSAGE_DIGEST {
            &mut message_digest
        } else {
            continue;
        };
        let [value] = vals.as_slice() else {
            return Err(AnchorError::Malformed("attribute must have one value"));
        };
        if slot.replace(value.content).is_some() {
            return Err(AnchorError::Malformed("duplicate signed attribute"));
        }
        if oid == OID_ATTR_CONTENT_TYPE {
            value.expect(TAG_OID, "contentType value")?;
        } else {
            value.expect(TAG_OCTET_STRING, "messageDigest value")?;
        }
    }
    if content_type != Some(OID_CT_TST_INFO) {
        return Err(AnchorError::Malformed("signed contentType is not TSTInfo"));
    }
    let message_digest = message_digest.ok_or(AnchorError::Malformed("missing messageDigest"))?;
    let digest_alg_impl = digest_algorithm(digest_oid)?;
    if digest::digest(digest_alg_impl, tst_info_der).as_ref() != message_digest {
        return Err(AnchorError::DigestMismatch);
    }

    // certificates: embedded set + trusted set
    let embedded_ders: Vec<&[u8]> = match cert_set {
        Some(set) => set
            .children()?
            .into_iter()
            .filter(|t| t.tag == TAG_SEQUENCE)
            .map(|t| t.raw)
            .collect(),
        None => Vec::new(),
    };
    let embedded = embedded_ders
        .iter()
        .map(|d| Cert::parse(d))
        .collect::<Result<Vec<_>, _>>()?;
    let trusted = trusted
        .iter()
        .map(|d| Cert::parse(d))
        .collect::<Result<Vec<_>, _>>()?;

    // signer certificate named by sid (issuerAndSerialNumber, or [0] subjectKeyIdentifier)
    let signer = embedded
        .iter()
        .find(|c| match sid.tag {
            TAG_SEQUENCE => sid.children().is_ok_and(|k| match k.as_slice() {
                [name, serial_no] => {
                    name.raw == c.issuer_der.as_slice()
                        && strip_leading_zeros(serial_no.content) == c.serial()
                }
                _ => false,
            }),
            TAG_CTX0_PRIMITIVE => c
                .parsed
                .tbs_certificate()
                .get_extension::<SubjectKeyIdentifier>()
                .ok()
                .flatten()
                .is_some_and(|(_, ski)| ski.0.as_bytes() == sid.content),
            _ => false,
        })
        .ok_or(AnchorError::SignerNotFound)?;

    // signature over the DER of signedAttrs with the universal SET tag (CMS §5.4)
    let mut signed_attrs_der = signed_attrs.raw.to_vec();
    if let Some(first) = signed_attrs_der.first_mut() {
        *first = TAG_SET;
    }
    verify_signature(
        sig_oid,
        digest_oid,
        signer.public_key(),
        &signed_attrs_der,
        signature_value,
    )?;

    // only now bind the token to the expected hash (reporting a hash mismatch for a forged token would be misleading)
    if imprint_hash.content != expected_hash.as_slice() {
        return Err(AnchorError::HashMismatch);
    }

    check_timestamping_eku(signer)?;
    check_chain(signer, &embedded, &trusted, gen_time)?;

    let gen_time_unix =
        i64::try_from(gen_time).map_err(|_| AnchorError::Malformed("genTime out of range"))?;
    Ok(TimestampInfo {
        gen_time_unix,
        policy: oid_text(policy.content),
        serial_hex: hex::encode(strip_leading_zeros(serial.content)),
        signer_serial_hex: hex::encode(signer.serial()),
    })
}
