## Summary
This PR focuses on runtime security hardening and memory hygiene while preserving upstream design and UX.

## What Was Added And Improved
- Stronger cryptographic memory handling (key material and temporary buffers).
- Safer session key/payload lifecycle and cleanup logic.
- More robust IndexedDB transaction and connection handling.
- Reduced plaintext lifetime across upload/download/editor/viewer/export/zip flows.
- Additional cleanup during password rotation and full re-encryption.

## Detailed Changes
### crypto.js
- Normalized password input to byte arrays before Argon2.
- Explicitly wiped temporary password/hash buffers.
- Added stricter IV validation and safer Uint8Array offset handling.
- Improved temporary crypto-buffer cleanup paths.

### state.js
- Wiped raw key bytes after CryptoKey import.
- Wiped decrypted/encrypted session payload buffers after use.
- Hardened browser-scope key unwrap/migration flows.
- Improved cleanup of cached session keys when unused.

### db.js
- Added DB initialization guard before transactions.
- Improved safety around DB lifecycle/version-change events.

### fileops.js
- Wiped plaintext buffers after encryption in upload paths.
- Wiped decrypted buffers after download/export handoff.
- Wiped temporary decrypted data in ZIP export flow.

### home.js
- Added extra buffer cleanup in password-change flow.
- Added extra buffer cleanup in batch file re-encryption flow.

## Bugs Fixed
- Reduced risk of raw key material lingering in memory.
- Fixed incomplete decrypted payload cleanup in session paths.
- Fixed plaintext retention in several file/view/export scenarios.
- Improved resilience after IndexedDB connection invalidation.

## Compatibility
- Upstream visual design is preserved.
- Browser architecture (WebCrypto + IndexedDB) is preserved.
- No new native/server-side dependencies were introduced.

## Result
Security posture is stronger, memory handling is cleaner, and runtime behavior is more robust, while keeping the same user-facing design direction.