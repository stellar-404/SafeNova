## Summary
This pull request hardens SafeNova runtime security and memory hygiene while preserving upstream design and UX.

## Main Improvements
- Strengthened cryptographic runtime handling of key material and temporary buffers.
- Safer session key and payload lifecycle handling.
- More robust IndexedDB transaction and lifecycle safety.
- Reduced plaintext lifetime across upload/download/editor/viewer/export/zip flows.
- Additional cleanup during password change and full re-encryption.

## File-Level Changes
- `crypto.js`: password/hash cleanup, IV validation, safer Uint8Array view handling.
- `state.js`: raw key/session payload cleanup, safer browser-scope key handling.
- `db.js`: DB initialization guard and version-change safety.
- `fileops.js`: plaintext/decrypted buffer cleanup in file operations.
- `home.js`: additional cleanup in password rotation and re-encryption flows.

## Bugs Fixed
- Reduced risk of lingering raw key material in memory.
- Fixed incomplete decrypted payload cleanup in session paths.
- Fixed plaintext retention in several file/view/export paths.
- Improved resilience after IndexedDB connection invalidation.

## Compatibility
- Upstream visual design preserved.
- Browser architecture (WebCrypto + IndexedDB) preserved.
- No native or server-side dependencies introduced.

## Result
Security posture and runtime stability are improved without changing user-facing design behavior.