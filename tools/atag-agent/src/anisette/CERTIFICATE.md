Apple Root CA (DER) was downloaded from Apple's PKI on 2026-11-08:

- Catalogue: https://www.apple.com/certificateauthority/ (Apple Inc. Root)
- Certificate: https://www.apple.com/appleca/AppleIncRootCertificate.cer
- SHA-256: B0B1730ECBC7FF4505142C49F1295E6EDA6BCAED7E2C68C5BE91B5A11001F024

Only the dedicated client for fixed Apple authentication, machine provisioning
and Find My endpoints trusts this root. The remote Anisette client and APK
download client retain the standard public root store. TLS certificate-chain
and hostname validation remain enabled, and redirects are disabled.
