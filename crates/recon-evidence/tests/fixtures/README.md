# Fixtures for `tests/anchor.rs`

Real RFC 3161 responses obtained on 2026-10-23 from public time-stamping endpoints, each for the SHA-256 of
`recon L7 anchor fixture 2026-10-23` (`imprint.sha256.hex`), request nonce `0x0123456789abcdef`, `certReq = TRUE`.
They are test inputs only. **Nothing here establishes that any of these TSAs is a qualified trust service provider**
(that is decided from the EU Trusted List, Progress.md decision D-7).

| File | Endpoint (POST, `application/timestamp-query`) | Signature | Trust anchor used by the tests |
|---|---|---|---|
| `freetsa.tsr` | `https://freetsa.org/tsr` | ECDSA P-384 + SHA-512 (unsupported by the verifier: asserted as such) | `freetsa-root.der` (`https://freetsa.org/files/cacert.pem`) |
| `digicert.tsr` | `http://timestamp.digicert.com` | RSA PKCS#1 v1.5 | `digicert-root-g4.der` (`https://cacerts.digicert.com/DigiCertTrustedRootG4.crt`), SHA-256 `552f7bdc…c89988` |
| `certum.tsr` | `http://time.certum.pl` (Asseco Data Systems, PL) | RSA PKCS#1 v1.5 (SHA-384) | `certum-ctnca2.der` (`http://repository.certum.pl/ctnca2.cer`), SHA-256 `b676f2ed…d0b804` |
| `globalsign.tsr` | `http://timestamp.globalsign.com/tsa/r6advanced1` (GlobalSign, BE) | RSA PKCS#1 v1.5 (SHA-384) | `globalsign-root-r6.der` (`http://secure.globalsign.com/cacert/root-r6.crt`), SHA-256 `2cabeafe…6ccf69` |

`certum-ctnca.der` is the older Certum root, kept because the token also embeds a cross-certificate issued by it.
Root certificates were downloaded from the issuers' own repositories over the network without independent
out-of-band fingerprint verification beyond the DigiCert G4 value, which matches the fingerprint published by DigiCert
(prior knowledge, tag K). They must NOT be used as production trust anchors; production anchors come from the EU
Trusted List once D-7 is decided.
