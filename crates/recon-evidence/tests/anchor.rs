//! L7 — ledger anchor (RFC 3161) verification.
//!
//! Two independent sources of tokens:
//!   * REAL tokens obtained from public test TSAs on 2026-10-23 (`tests/fixtures/README.md`): RSA-signed, certificate
//!     chains issued by third parties — this proves the verifier parses and validates tokens it did not produce;
//!   * synthetic ECDSA P-256 tokens from a test TSA built in this file (certificates by `rcgen`, signatures by `ring`),
//!     used for the algorithm and policy variants no public TSA lets us produce on demand (no time-stamping EKU,
//!     expired certificate, untrusted chain, multi-level chain).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use rcgen::{
    BasicConstraints, CertificateParams, CustomExtension, DnType, IsCa, Issuer, KeyPair,
    date_time_ymd,
};
use recon_evidence::Hash;
use recon_evidence::anchor::{
    AnchorError, TimestampInfo, token_from_response, verify_timestamp_token,
};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair};
use sha2::{Digest, Sha256};
use x509_cert::Certificate;
use x509_cert::der::{Decode, Encode};

// Real tokens, obtained 2026-10-23 (provenance: tests/fixtures/README.md). Roots are the TSAs' self-signed CA certificates.
const FREETSA_RESPONSE: &[u8] = include_bytes!("fixtures/freetsa.tsr"); // ECDSA P-384 + SHA-512: unsupported by `ring`
const FREETSA_ROOT: &[u8] = include_bytes!("fixtures/freetsa-root.der");
const DIGICERT_RESPONSE: &[u8] = include_bytes!("fixtures/digicert.tsr");
const DIGICERT_ROOT: &[u8] = include_bytes!("fixtures/digicert-root-g4.der");
const CERTUM_RESPONSE: &[u8] = include_bytes!("fixtures/certum.tsr"); // EU (PL) TSA
const CERTUM_ROOT: &[u8] = include_bytes!("fixtures/certum-ctnca2.der");
const GLOBALSIGN_RESPONSE: &[u8] = include_bytes!("fixtures/globalsign.tsr"); // EU (BE) TSA
const GLOBALSIGN_ROOT: &[u8] = include_bytes!("fixtures/globalsign-root-r6.der");

/// Real tokens this verifier supports: (name, TimeStampResp, trust anchor).
const SUPPORTED_REAL: [(&str, &[u8], &[u8]); 3] = [
    ("digicert", DIGICERT_RESPONSE, DIGICERT_ROOT),
    ("certum", CERTUM_RESPONSE, CERTUM_ROOT),
    ("globalsign", GLOBALSIGN_RESPONSE, GLOBALSIGN_ROOT),
];
const IMPRINT_HEX: &str = include_str!("fixtures/imprint.sha256.hex");
/// What the fixtures were requested for: the SHA-256 of this text stands in for a ledger chain head.
const IMPRINT_PREIMAGE: &[u8] = b"recon L7 anchor fixture 2026-10-23";

// 2026-10-23T00:00:00Z .. 2026-10-24T00:00:00Z: the day the fixtures were obtained
const FIXTURE_DAY: std::ops::Range<i64> = 1_792_713_600..1_792_800_000;

fn real_hash() -> Hash {
    let h: Hash = hex::decode(IMPRINT_HEX.trim()).unwrap().try_into().unwrap();
    assert_eq!(
        h.as_slice(),
        Sha256::digest(IMPRINT_PREIMAGE).as_slice(),
        "fixture imprint provenance"
    );
    h
}

// ------------------------------------------------------------------ minimal DER writer for the synthetic TSA

fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    match content.len() {
        n if n < 0x80 => out.push(u8::try_from(n).unwrap()),
        n if n < 0x100 => out.extend([0x81, u8::try_from(n).unwrap()]),
        n => out.extend([
            0x82,
            u8::try_from(n >> 8).unwrap(),
            u8::try_from(n & 0xff).unwrap(),
        ]),
    }
    out.extend_from_slice(content);
    out
}

fn cat(parts: &[&[u8]]) -> Vec<u8> {
    parts.concat()
}

fn seq(parts: &[&[u8]]) -> Vec<u8> {
    tlv(0x30, &cat(parts))
}

fn oid(content: &[u8]) -> Vec<u8> {
    tlv(0x06, content)
}

const OID_SIGNED_DATA: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02];
const OID_TST: &[u8] = &[
    0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x10, 0x01, 0x04,
];
const OID_CT_ATTR: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x03];
const OID_MD_ATTR: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x04];
const OID_SHA256: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const OID_ECDSA_SHA256: &[u8] = &[0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02];
const EKU_EXTENSION_VALUE: &[u8] = &[
    0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x08,
];

fn sha256_alg() -> Vec<u8> {
    seq(&[&oid(OID_SHA256), &tlv(0x05, &[])])
}

/// A signed token over `hash` by `signer_key`, embedding `certs`; the SignerInfo names `signer_cert`.
fn build_token(
    signer_key: &KeyPair,
    signer_cert: &[u8],
    certs: &[&[u8]],
    hash: &Hash,
    gen_time: &str,
) -> Vec<u8> {
    let tst_info = seq(&[
        &tlv(0x02, &[1]),
        &oid(&[0x2A, 0x03, 0x04]),
        &seq(&[&sha256_alg(), &tlv(0x04, hash)]),
        &tlv(0x02, &[0x01, 0x02]),
        &tlv(0x18, gen_time.as_bytes()),
    ]);
    let attr_ct = seq(&[&oid(OID_CT_ATTR), &tlv(0x31, &oid(OID_TST))]);
    let attr_md = seq(&[
        &oid(OID_MD_ATTR),
        &tlv(0x31, &tlv(0x04, Sha256::digest(&tst_info).as_slice())),
    ]);
    let attrs = cat(&[&attr_ct, &attr_md]);
    let to_sign = tlv(0x31, &attrs);
    let rng = SystemRandom::new();
    let pair = EcdsaKeyPair::from_pkcs8(
        &ECDSA_P256_SHA256_ASN1_SIGNING,
        &signer_key.serialize_der(),
        &rng,
    )
    .unwrap();
    let sig = pair.sign(&rng, &to_sign).unwrap();

    let parsed = Certificate::from_der(signer_cert).unwrap();
    let issuer = parsed.tbs_certificate().issuer().to_der().unwrap();
    let serial = tlv(0x02, parsed.tbs_certificate().serial_number().as_bytes());
    let signer_info = seq(&[
        &tlv(0x02, &[1]),
        &seq(&[&issuer, &serial]),
        &sha256_alg(),
        &tlv(0xA0, &attrs),
        &seq(&[&oid(OID_ECDSA_SHA256)]),
        &tlv(0x04, sig.as_ref()),
    ]);
    let cert_blob: Vec<u8> = certs.concat();
    let signed_data = seq(&[
        &tlv(0x02, &[3]),
        &tlv(0x31, &sha256_alg()),
        &seq(&[&oid(OID_TST), &tlv(0xA0, &tlv(0x04, &tst_info))]),
        &tlv(0xA0, &cert_blob),
        &tlv(0x31, &signer_info),
    ]);
    seq(&[&oid(OID_SIGNED_DATA), &tlv(0xA0, &signed_data)])
}

// ------------------------------------------------------------------ synthetic PKI

struct Pki {
    key: KeyPair,
    der: Vec<u8>,
    issuer: Issuer<'static, KeyPair>,
}

fn params(
    cn: &str,
    ca: bool,
    valid: ((i32, u8, u8), (i32, u8, u8)),
    eku: Option<bool>,
) -> CertificateParams {
    let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
    p.distinguished_name.push(DnType::CommonName, cn);
    p.is_ca = if ca {
        IsCa::Ca(BasicConstraints::Unconstrained)
    } else {
        IsCa::ExplicitNoCa
    };
    p.not_before = date_time_ymd((valid.0).0, (valid.0).1, (valid.0).2);
    p.not_after = date_time_ymd((valid.1).0, (valid.1).1, (valid.1).2);
    if let Some(critical) = eku {
        let mut ext =
            CustomExtension::from_oid_content(&[2, 5, 29, 37], EKU_EXTENSION_VALUE.to_vec());
        ext.set_criticality(critical);
        p.custom_extensions.push(ext);
    }
    p
}

const ALWAYS: ((i32, u8, u8), (i32, u8, u8)) = ((2020, 1, 1), (2040, 1, 1));

fn self_signed(
    cn: &str,
    ca: bool,
    valid: ((i32, u8, u8), (i32, u8, u8)),
    eku: Option<bool>,
) -> Pki {
    let key = KeyPair::generate().unwrap();
    let p = params(cn, ca, valid, eku);
    let der = p.self_signed(&key).unwrap().der().to_vec();
    let issuer = Issuer::new(
        p,
        KeyPair::try_from(key.serialize_der().as_slice()).unwrap(),
    );
    Pki { key, der, issuer }
}

fn issued_by(
    parent: &Pki,
    cn: &str,
    ca: bool,
    valid: ((i32, u8, u8), (i32, u8, u8)),
    eku: Option<bool>,
) -> Pki {
    let key = KeyPair::generate().unwrap();
    let p = params(cn, ca, valid, eku);
    let der = p.signed_by(&key, &parent.issuer).unwrap().der().to_vec();
    let issuer = Issuer::new(
        p,
        KeyPair::try_from(key.serialize_der().as_slice()).unwrap(),
    );
    Pki { key, der, issuer }
}

const GEN: &str = "20261023120000Z";
const GEN_UNIX: i64 = 1_792_756_800; // 2026-10-23T12:00:00Z

fn hash(n: u8) -> Hash {
    Sha256::digest([n]).into()
}

// ------------------------------------------------------------------ tests

#[test]
fn anchor_token_verifies_against_test_tsa() {
    // real third-party tokens
    let h = real_hash();
    for (name, response, root) in SUPPORTED_REAL {
        let token = token_from_response(response).unwrap();
        let info: TimestampInfo =
            verify_timestamp_token(token, &h, &[root]).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(
            FIXTURE_DAY.contains(&info.gen_time_unix),
            "{name}: genTime {}",
            info.gen_time_unix
        );
        assert!(
            !info.policy.is_empty()
                && !info.serial_hex.is_empty()
                && !info.signer_serial_hex.is_empty()
        );
    }

    // synthetic: TSA certificate trusted directly
    let tsa = self_signed("Test TSA", false, ALWAYS, Some(true));
    let token = build_token(&tsa.key, &tsa.der, &[&tsa.der], &hash(1), GEN);
    let info = verify_timestamp_token(&token, &hash(1), &[&tsa.der]).unwrap();
    assert_eq!(info.gen_time_unix, GEN_UNIX);
    assert_eq!(info.policy, "1.2.3.4");
    assert_eq!(info.serial_hex, "0102");

    // synthetic: root -> intermediate CA -> TSA leaf; only the root is trusted, the rest is embedded
    let root = self_signed("Test Root", true, ALWAYS, None);
    let mid = issued_by(&root, "Test Intermediate", true, ALWAYS, None);
    let leaf = issued_by(&mid, "Test TSA Leaf", false, ALWAYS, Some(true));
    let token = build_token(&leaf.key, &leaf.der, &[&leaf.der, &mid.der], &hash(2), GEN);
    verify_timestamp_token(&token, &hash(2), &[&root.der]).unwrap();
}

#[test]
fn anchor_rejects_wrong_hash() {
    let h = real_hash();
    for (_, response, root) in SUPPORTED_REAL {
        let token = token_from_response(response).unwrap();
        let mut other = h;
        other[31] ^= 1;
        assert_eq!(
            verify_timestamp_token(token, &other, &[root]),
            Err(AnchorError::HashMismatch)
        );
    }
    let tsa = self_signed("Test TSA", false, ALWAYS, Some(true));
    let token = build_token(&tsa.key, &tsa.der, &[&tsa.der], &hash(1), GEN);
    assert_eq!(
        verify_timestamp_token(&token, &hash(2), &[&tsa.der]),
        Err(AnchorError::HashMismatch)
    );
}

#[test]
fn anchor_rejects_tampered_token() {
    let h = real_hash();
    // real token: change one bit of the imprint inside the signed TSTInfo => the signed digest no longer matches
    let token = token_from_response(CERTUM_RESPONSE).unwrap().to_vec();
    let at = token
        .windows(32)
        .position(|w| w == h)
        .expect("imprint inside token");
    let mut forged = token.clone();
    forged[at] ^= 1;
    let mut forged_hash = h;
    forged_hash[0] ^= 1;
    assert_eq!(
        verify_timestamp_token(&forged, &forged_hash, &[CERTUM_ROOT]),
        Err(AnchorError::DigestMismatch)
    );

    // synthetic: flip the last byte (inside the ECDSA signature value)
    let tsa = self_signed("Test TSA", false, ALWAYS, Some(true));
    let mut token = build_token(&tsa.key, &tsa.der, &[&tsa.der], &hash(1), GEN);
    verify_timestamp_token(&token, &hash(1), &[&tsa.der]).unwrap();
    let last = token.len() - 1;
    token[last] ^= 1;
    assert_eq!(
        verify_timestamp_token(&token, &hash(1), &[&tsa.der]),
        Err(AnchorError::BadSignature)
    );

    // a token whose signer cert is swapped for another key's cert (same names) does not verify
    let other = self_signed("Test TSA", false, ALWAYS, Some(true));
    let token = build_token(&tsa.key, &tsa.der, &[&other.der], &hash(1), GEN);
    assert!(verify_timestamp_token(&token, &hash(1), &[&other.der]).is_err());

    // no truncation of a real token may verify, and none may panic
    let real = token_from_response(DIGICERT_RESPONSE).unwrap();
    for n in 0..real.len() {
        assert!(
            verify_timestamp_token(&real[..n], &h, &[DIGICERT_ROOT]).is_err(),
            "prefix {n} accepted"
        );
    }
}

#[test]
fn anchor_rejects_untrusted_or_unfit_signers() {
    let tsa = self_signed("Test TSA", false, ALWAYS, Some(true));
    let token = build_token(&tsa.key, &tsa.der, &[&tsa.der], &hash(1), GEN);

    // trust store without the signer's issuer
    let stranger = self_signed("Other Root", true, ALWAYS, None);
    assert_eq!(
        verify_timestamp_token(&token, &hash(1), &[&stranger.der]),
        Err(AnchorError::UntrustedSigner)
    );
    assert_eq!(
        verify_timestamp_token(&token, &hash(1), &[]),
        Err(AnchorError::UntrustedSigner)
    );
    // the real TSA's token under another TSA's root
    let real = token_from_response(CERTUM_RESPONSE).unwrap();
    assert_eq!(
        verify_timestamp_token(real, &real_hash(), &[DIGICERT_ROOT]),
        Err(AnchorError::UntrustedSigner)
    );

    // no extended key usage / non-critical extended key usage
    for eku in [None, Some(false)] {
        let t = self_signed("No EKU TSA", false, ALWAYS, eku);
        let token = build_token(&t.key, &t.der, &[&t.der], &hash(1), GEN);
        assert_eq!(
            verify_timestamp_token(&token, &hash(1), &[&t.der]),
            Err(AnchorError::NotATimestampingCertificate),
            "eku {eku:?}"
        );
    }

    // certificate not valid at genTime (expired before 2026-10-23, and not yet valid)
    for valid in [((2020, 1, 1), (2025, 12, 31)), ((2027, 1, 1), (2030, 1, 1))] {
        let t = self_signed("Dated TSA", false, valid, Some(true));
        let token = build_token(&t.key, &t.der, &[&t.der], &hash(1), GEN);
        assert_eq!(
            verify_timestamp_token(&token, &hash(1), &[&t.der]),
            Err(AnchorError::NotValidAtGenTime)
        );
    }

    // an issuer that is not a CA may not vouch for a leaf
    let root = self_signed("Root", true, ALWAYS, None);
    let not_ca = issued_by(&root, "Not A CA", false, ALWAYS, None);
    let leaf = issued_by(&not_ca, "Leaf", false, ALWAYS, Some(true));
    let token = build_token(
        &leaf.key,
        &leaf.der,
        &[&leaf.der, &not_ca.der],
        &hash(1),
        GEN,
    );
    assert_eq!(
        verify_timestamp_token(&token, &hash(1), &[&root.der]),
        Err(AnchorError::IssuerNotCa)
    );
}

#[test]
fn timestamp_response_status_and_encoding_are_enforced() {
    let tsa = self_signed("Test TSA", false, ALWAYS, Some(true));
    let token = build_token(&tsa.key, &tsa.der, &[&tsa.der], &hash(1), GEN);

    let granted = seq(&[&seq(&[&tlv(0x02, &[0])]), &token]);
    assert_eq!(token_from_response(&granted).unwrap(), token.as_slice());
    let with_mods = seq(&[&seq(&[&tlv(0x02, &[1])]), &token]);
    assert_eq!(token_from_response(&with_mods).unwrap(), token.as_slice());
    let rejected = seq(&[&seq(&[&tlv(0x02, &[2])])]);
    assert_eq!(
        token_from_response(&rejected),
        Err(AnchorError::NotGranted(2))
    );
    assert!(matches!(
        token_from_response(&seq(&[&seq(&[&tlv(0x02, &[0])])])),
        Err(AnchorError::Malformed(_))
    ));

    // BER indefinite length is refused (tokens must be DER)
    let mut ber = token.clone();
    ber[1] = 0x80;
    assert!(matches!(
        verify_timestamp_token(&ber, &hash(1), &[&tsa.der]),
        Err(AnchorError::Malformed(_))
    ));
    // trailing garbage is refused
    let mut padded = token;
    padded.push(0);
    assert!(matches!(
        verify_timestamp_token(&padded, &hash(1), &[&tsa.der]),
        Err(AnchorError::Malformed(_))
    ));
}

#[test]
fn unsupported_signature_algorithms_are_reported_not_accepted() {
    // FreeTSA signs with ECDSA P-384 + SHA-512 (OID 1.2.840.10045.4.3.4); `ring` cannot verify that pair, so the
    // verifier must say so instead of skipping the signature check.
    let token = token_from_response(FREETSA_RESPONSE).unwrap();
    assert_eq!(
        verify_timestamp_token(token, &real_hash(), &[FREETSA_ROOT]),
        Err(AnchorError::UnsupportedAlgorithm(
            "1.2.840.10045.4.3.4".to_owned()
        ))
    );
}
