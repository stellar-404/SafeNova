![](./pics/intro.png)

> ### Try it online: [https://safenova.dosx.su/](https://safenova.dosx.su/)

## ❔ What it is

SafeNova is a single-page web app that lets you create encrypted **containers** — isolated vaults where you can organize files in a folder structure, much like a regular desktop file manager. Everything is encrypted client-side before being written to storage. Nothing ever leaves your device.

![](./pics/screenshot.png)

Key properties:

-   **Zero-knowledge** — the app never sees your password or plaintext data
-   **Offline-first** — works entirely without network access
-   **No installation** — start the local server and you're running (or use online)

---

## ⚙️ Features

-   **Multiple containers** — each with its own password and independent storage limit (8 GB per container)
-   **Virtual filesystem** — nested folders, drag-to-reorder icons, customizable folder colors
-   **File operations** — upload (drag & drop or browse; folder upload with 4× parallel encryption), download, copy, cut, paste, rename, delete
-   **Built-in viewers** — text editor, image viewer, audio/video player, PDF viewer
-   **Hardware key support** — optionally use a WebAuthn passkey to strengthen the container salt
-   **Session memory** — optionally remember your session per tab (ephemeral, recommended) or persistently until manually signed out, using AES-GCM-encrypted session tokens; persistent sessions survive browser restarts
-   **Cross-tab session protection** — a container can only be actively open in one browser tab at a time; a lightweight lock protocol detects conflicts and offers instant session takeover
-   **Container import / export** — portable `.safenova` container files; import reads the archive via streaming `File.slice()` without loading the full file into memory, making multi-gigabyte imports possible; export streams data chunk-by-chunk requiring no single contiguous allocation regardless of container size
-   **Export password guard** — configurable setting (on by default) to require password confirmation before exporting; when disabled, active-session key is used directly
-   **Sort & arrange** — sort icons by name, date, size, or type; drag to custom positions
-   **Secure container deletion** — before permanent erasure, the first 8 bytes of every encrypted blob are overwritten with zeros (cryptographic pre-shredding), ensuring the AES-GCM ciphertext is irrecoverable even on storage media that lazily reclaims pages
-   **Container integrity scanner** — 27 automated checks (21 VFS structural + 6 database-level) with one-click auto-repair, **Deep Clean** (flattens over-nested folder trees, repairs all metadata), and a backup prompt before any destructive operation
-   **Settings** — three tabs: personalization, statistics, activity logs
-   **Keyboard shortcuts** — `Delete`, `F2`, `Ctrl+A`, `Ctrl+C/X/V`, `Ctrl+S` (save in editor), `Escape`
-   **Mobile-friendly** — long-press to drag icons, rubber-band selection, single/double-tap gestures, paste at finger position, multi-file drag with per-item snap previews

---

## 🔐 Encryption

| Layer            | Algorithm                                              |
| ---------------- | ------------------------------------------------------ |
| Key derivation   | Argon2id (19 MB memory, 2 iterations, 1 thread)        |
| File encryption  | AES-256-GCM (random 96-bit IV per file)                |
| VFS encryption   | AES-256-GCM (same key, independent IV)                 |
| Session tokens   | AES-256-GCM, dual-key: per-tab ephemeral or persistent |
| Browser key wrap | HKDF-SHA-256 from fingerprint + cookie + IndexedDB     |
| Integrity check  | AES-256-GCM verification blob authenticated on open    |

Every file is encrypted individually — each with its own freshly generated IV. The virtual filesystem (folder tree, file names, sizes, positions) is encrypted as a separate blob using the same derived key. The plaintext password is never stored; only the derived key is held in JavaScript memory for the duration of an active session.

File keys are derived from passwords through **Argon2id** with OWASP-recommended minimum parameters (19 MB memory cost, 2 iterations), providing strong resistance against brute-force and GPU-accelerated attacks.

### Session token security

SafeNova uses a **dual-key model** for session storage — an ephemeral per-tab key and a persistent shared key — each scoped to a distinct user intent.

#### Current tab session _(Recommended)_

The 32-byte Argon2id key material is encrypted with **`snv-sk`** — a per-tab AES-256-GCM key stored in `sessionStorage`. `snv-sk` is itself wrap-encrypted with the same three-source HKDF key as `snv-bsk` before being written to `sessionStorage`. This means:

-   The session blob (`snv-s-{cid}`) lives in `sessionStorage` and is readable only by the exact tab that created it
-   Closing the tab permanently destroys `snv-sk` — no residue remains in any persistent storage
-   An attacker with access to `localStorage`, `sessionStorage`, or disk snapshots gains nothing — even a raw `sessionStorage` dump does not expose the decryption key without also possessing the browser fingerprint, the `snv-kc` cookie, and the `SafeNovaKS` IDB record

This is the recommended option: the session is automatically gone as soon as the tab is closed.

#### Stay signed in

The key material is encrypted with **`snv-bsk`** — a shared AES-256-GCM key available to all tabs of the same browser origin.

#### Three-source key wrapping

Before `snv-bsk` is written to `localStorage`, it is itself encrypted with a separate _wrap key_ that is derived on-the-fly via **HKDF-SHA-256** from **three independent sources** and **never stored anywhere**:

| #   | Source              | Storage                                       | Purpose                                                                 |
| --- | ------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Browser fingerprint | _(computed)_                                  | `origin \0 userAgent \0 platform \0 language \0 hardwareConcurrency \0 colorDepth \0 pixelDepth` |
| 2   | `snv-kc` cookie     | Cookie jar (`SameSite=Strict`, ~400 days TTL) | 32 random bytes, isolated from localStorage                             |
| 3   | `snv-ki` record     | Separate IndexedDB `SafeNovaKS`               | 32 random bytes, independent from main `SafeNovaEFS` database           |

```
ikm      = fingerprint \0 cookie_bytes(32) \0 idb_bytes(32)
wrap_key = HKDF-SHA-256( ikm, salt=0×32, info="snv-browser-wrap-v3" )
snv-bsk (localStorage)   = IV(12) || AES-256-GCM( wrap_key, raw_bsk_bytes )
snv-sk  (sessionStorage) = IV(12) || AES-256-GCM( wrap_key, raw_sk_bytes  )
```

Consequences:

-   Any tab in the **same browser** recomputes the identical fingerprint, reads the same cookie and IDB secret → identical wrap key → can decrypt `snv-bsk` and resume the session seamlessly
-   An attacker must compromise **all three storage mechanisms** simultaneously to reconstruct the wrap key — `localStorage` alone, a disk image, or a partial export will not suffice:
    -   Copying `localStorage` without the cookie and `SafeNovaKS` database → wrap key cannot be derived → `snv-bsk` is opaque
    -   Clearing cookies invalidates the cookie component → sessions become undecryptable
    -   Deleting or moving the `SafeNovaKS` database invalidates the IDB component → same effect
-   The fingerprint includes `navigator.userAgent` and `navigator.platform`, binding sessions to the specific browser version and OS. **Browser updates that change the UA string will invalidate existing sessions** — the user re-enters their password once and a new session is established automatically
-   If any of the three components change (fingerprint shift, cookie clearing, IDB loss), the stored `snv-bsk` can no longer be decrypted; a new key is generated automatically and the user must re-enter the password once — any `snv-sb-{cid}` blobs encrypted with the old key are silently dropped
-   **Legacy format migration:** `snv-bsk` and `snv-sk` entries written before wrap-encryption was introduced (raw 32-byte keys, no IV prefix) are detected by their exact byte length and silently re-wrapped in the current `IV(12) || AES-GCM` format on first access — no user action required
-   The session expires after **7 days** (TTL baked into the encrypted payload), or immediately on explicit sign-out

#### Session payload format

Both scope types use the same blob layout: `IV(12) || AES-256-GCM(scope_key, expiry(8 bytes, uint64 LE) || raw_key(32 bytes))`. The AES-GCM call is authenticated with the container ID as additional data (`snv-session:{cid}`), preventing a blob from one container from being replayed to unlock a different container. Tab-scope sessions use `expiry = Number.MAX_SAFE_INTEGER` (no TTL — the tab's `sessionStorage` is the only lifetime bound); browser-scope sessions carry a hard 7-day expiry.

#### Remaining trade-off

An attacker with live access to the running browser process (e.g. malicious extension, XSS) can still call the same fingerprint function, read the cookie, and query the `SafeNovaKS` IndexedDB to derive the wrap key. The three-source wrapping layer protects against _offline_ credential theft (disk images, direct `localStorage` dumps, partial storage exports), not against in-browser code execution.

---

## 🔒 Content Security Policy

### Meta tag (inline)

`index.html` declares a strict per-directive CSP via `<meta http-equiv="Content-Security-Policy">`:

| Directive     | Value                       |
| ------------- | --------------------------- |
| `default-src` | `'none'`                    |
| `script-src`  | `'self' 'wasm-unsafe-eval'` |
| `style-src`   | `'self' 'unsafe-inline'`    |
| `img-src`     | `'self' blob: data:`        |
| `media-src`   | `blob:`                     |
| `frame-src`   | `blob:`                     |
| `font-src`    | `'self'`                    |
| `connect-src` | `'self'`                    |
| `worker-src`  | `'self' blob:`              |
| `base-uri`    | `'self'`                    |
| `form-action` | `'none'`                    |
| `object-src`  | `'none'`                    |

`'unsafe-inline'` is absent from `script-src`. There are no inline `<script>` blocks — the docmode persistence guard (`docmode.js`) is loaded as an external file before the stylesheet. All JavaScript is loaded via `'self'`. Argon2id WASM compilation is permitted by `'wasm-unsafe-eval'`.

### Server-level headers (`.server.ps1`)

When running via the included PowerShell dev server, every response additionally carries:

| Header                         | Value                                                          |
| ------------------------------ | -------------------------------------------------------------- |
| `X-Content-Type-Options`       | `nosniff`                                                      |
| `X-Frame-Options`              | `DENY`                                                         |
| `Referrer-Policy`              | `no-referrer`                                                  |
| `Permissions-Policy`           | `interest-cohort=(), geolocation=(), camera=(), microphone=()` |
| `Cross-Origin-Opener-Policy`   | `same-origin`                                                  |
| `Cross-Origin-Embedder-Policy` | `require-corp`                                                 |

`Cross-Origin-Opener-Policy: same-origin` prevents other origins from holding a reference to the app window. `Cross-Origin-Embedder-Policy: require-corp` blocks cross-origin subresource loads that lack explicit CORP headers — irrelevant in practice since all resources are same-origin, but also a prerequisite for enabling `SharedArrayBuffer` if needed in the future.

---

## 📋 Requirements

-   A modern browser: **Chrome 90+**, **Firefox 90+**, **Safari 15+**, or **Edge 90+**
-   Web Crypto API must be available — this requires either **HTTPS** or **`localhost`**
-   No plugins, no extensions, no backend

---

## 🚀 Getting started

### Option A — Use online version

SafeNova is hosted on: [https://safenova.dosx.su/](https://safenova.dosx.su/)

### Option B — Local server

A zero-dependency PowerShell server is included:

```powershell
.\\.server.ps1
```

Or right-click the file → **Run with PowerShell**. It starts an HTTP server on port `7777` (or the next free port) and opens the app in your default browser.

No external installs needed — it uses the Windows built-in `HttpListener`.

---

## 📁 Project structure

```
SafeNova/
│
├── index.html          # Single-page app entry point
├── favicon.png         # Application icon
├── .server.ps1         # Local PowerShell dev server (Windows)
│
├── css/
│   └── app.css         # All application styles
│
└── js/
    ├── argon2.umd.min.js  # Argon2id WASM/JS implementation (hashwasm)
    ├── docmode.js         # Pre-CSS docmode guard (runs before stylesheet loads)
    ├── initlog.js         # Initialization stage console logger (InitLog)
    ├── constants.js       # Shared constants (DB names, limits, chunk size), utilities, icon SVGs
    ├── db.js              # IndexedDB abstraction — SafeNovaEFS (containers / files / vfs / chunks stores)
    ├── crypto.js          # AES-256-GCM + Argon2id encryption layer
    ├── vfs.js             # In-memory virtual filesystem (nodes, positions, child index)
    ├── state.js           # App state singleton — key, session encrypt/decrypt, three-source wrap key
    ├── home.js            # Container management: create, unlock, import, export, change password
    ├── desktop.js         # Desktop UI: icons, folder windows, drag & drop, integrity scanner
    ├── fileops.js         # File operations: upload, download, open, copy/paste, rename, delete, ZIP export
    └── main.js            # App boot, event binding, console security warning
```

---

## 🔒 How containers work

1. **Create** a container with a name and password
2. **Unlock** the container — Argon2id derives the key from your password
3. Files you upload are encrypted with AES-256-GCM before being saved to IndexedDB
4. The virtual filesystem (folder tree + icon positions) is also encrypted and saved separately
5. **Lock** the container — the derived key is immediately wiped from memory
6. **Delete** the container — first, the first 8 bytes of every encrypted blob are overwritten with zeros (cryptographic pre-shredding); then all encrypted records, the VFS blob, and the container metadata are permanently deleted from IndexedDB

All container data is scoped to the current browser and device. Use **Export Container** to back up or transfer to another device.

---

## 📄 The `.safenova` Container Format

Exported containers are saved as `.safenova` files. This is a **self-contained structured archive** with a versioned, deterministic layout. It is designed so that no file content or filesystem metadata is ever present in plaintext within the archive.

### Archive sections

| Section                      | Role                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `container.xml`              | Plaintext container manifest: name, creation timestamp, Argon2id salt, and the AES-GCM verification IV and blob needed to authenticate a password at import. No file names or content appear here |
| `meta/0`                     | The IV (initialization vector) used to encrypt the VFS blob                                                                                                                                       |
| `meta/1`                     | The encrypted VFS blob — the complete folder hierarchy, file names, MIME types, sizes, timestamps, icon positions, and folder colors, all ciphertext                                              |
| `meta/2`                     | The IV for the encrypted file manifest                                                                                                                                                            |
| `meta/3`                     | The encrypted file manifest — a JSON structure mapping each file’s internal ID to its byte offset and length within `workspace.bin`, encrypted with the container key                             |
| `safenova_efs/workspace.bin` | A single contiguous block of raw ciphertext — the encrypted content of every file, concatenated end-to-end. Without the decryption key, file boundaries and content are indistinguishable         |
| `meta/activity_logs/0`       | _(Optional)_ The encrypted activity log, included only when the `exportWithLogs` container setting is enabled                                                                                     |

### Design properties

#### Zero plaintext leakage

The only identifiable plaintext in the archive is the container name in `container.xml` and the Argon2id salt. All file names, folder structure, and content are ciphertext.

#### Lazy import

A `.safenova` file can be imported without entering the container password. The archive is parsed via `File.slice()` — only the ZIP directory and small metadata entries are fully read into memory; the `workspace.bin` payload is handled as a `Blob` reference. The encrypted workspace is stored as-is internally, flagged as a `lazyWorkspace`. It is expanded into the local database only on first unlock — so import is instantaneous regardless of container size.

#### Self-authenticating

The salt and verification blob in `container.xml` allow the application to confirm the correctness of a supplied password before touching any file data, preventing unnecessary decryption work.

#### Versioned

The `version` attribute in the XML manifest distinguishes between format generations, enabling forward-compatible import logic. Currently only version 3 is supported; earlier formats have been retired.

---

## ⚡ Performance

SafeNova schedules AES-GCM operations to run with maximum concurrency, taking full advantage of hardware AES acceleration exposed by the browser’s Web Crypto API.

### Adaptive concurrency

The degree of parallelism is computed once at startup:

```js
const _CRYPTO_CONCURRENCY = Math.min(8, navigator.hardwareConcurrency || 4);
```

This serves as the default batch width for all bulk encrypt/decrypt loops. On an 8-core machine, up to 8 files are processed simultaneously.

### Bulk upload

For each batch of files the application reads all `ArrayBuffer` payloads in parallel, encrypts the batch in parallel, then writes every encrypted record to IndexedDB in a **single transaction**, eliminating the per-file transaction overhead that would otherwise dominate for large numbers of small files. Files with encrypted blobs exceeding **50 MB** are stored as split 50 MB chunks across the `chunks` object store, avoiding the browser's ~2 GB structured-clone limit on IndexedDB reads; the chunking is fully transparent to all read paths.

### ZIP export

Exporting files as an archive uses `DB.getFilesByIds()` — a single IndexedDB read transaction that fetches all required records concurrently via parallel `IDBObjectStore.get()` calls. Decryption of all records is then dispatched in one `Promise.allSettled` call rather than being serialised through fixed-size batches.

### Password change

Re-encrypting a container under a new key dispatches all `decrypt → encrypt` pairs for every file **fully in parallel**. Results are accumulated and written back in a single `saveFiles()` batch, reducing total elapsed time from `O(n × sequential awaits)` to approximately one parallel round-trip plus one database write.

### Container export

Exporting a `.safenova` file requires no single contiguous memory allocation regardless of container size. The builder receives each file blob as an individual `Uint8Array` chunk (no concatenation into a giant `workspaceBin`), computes CRC32 incrementally over the chunk list via `_crc32multi()`, and emits an **array of small output parts**. `downloadBuf()` passes that parts array directly to the `Blob` constructor — the browser stitches the pieces together internally without requiring a duplicate allocation. The peak RAM footprint for an N-gigabyte export is approximately N bytes (the data already held in IndexedDB), rather than the previous ~3× N that caused `Array buffer allocation failed` errors for 3 GB+ containers.

### Drag-and-drop performance (large folders)

Icon dragging in folders with many files previously re-iterated all `VFS.children()` results on **every** `mousemove` / `touchmove` frame (~60 fps) to rebuild the occupied-cell map. With hundreds of files this became a measurable bottleneck. The hot path is now O(1) per frame:

-   **Touch drag** — the occupied map is built once at drag-start (when the 400 ms long-press fires) and reused throughout the gesture
-   **Mouse drag** — `srcOccupied` is built once at drag-start; `winOccCached` / `deskOccCached` are computed once when the pointer first enters a drop target, not on every frame
-   **Snap preview throttle** — snap-preview positions are recomputed only when the pointer crosses a grid cell boundary (96 px steps), not on every pixel movement
-   **No full map clone** — `_showPreviews` uses a small `extra` overlay Map (one entry per selected item) instead of cloning the full `occMap` on each call; `_snapFreeCell` accepts that overlay as an optional second map and checks both without merging them

---

## 🛡️ Cross-Tab Session Protection

To prevent a container from being open in two browser tabs simultaneously — which would risk conflicting VFS writes — SafeNova maintains a lightweight **session lock** in `localStorage`.

When a container is unlocked, the tab writes a claim entry (`snv-open-{id}`) containing its unique tab identifier and a timestamp. A **heartbeat** refreshes the timestamp every 5 seconds. Any other tab that reads a live claim (timestamp within the 30-second TTL) before opening the same container is shown a conflict dialog offering to take over the session.

On accepting the takeover, the requesting tab writes a **kick flag** into the claim entry. The original tab listens for `storage` events on this key and immediately locks itself when the flag is detected. On normal tab close, `beforeunload` and `pagehide` remove the claim entry so the container becomes available to other tabs without waiting for the TTL to expire.

---

## 📱 Mobile Touch Support

SafeNova is fully usable on touchscreen devices (Android Chrome, iOS Safari). All gesture interactions work on real hardware, not only in DevTools device emulation.

### Long-press to drag

Holding a finger on an icon for **400 ms** activates drag mode (haptic feedback where the OS supports it). The `touchstart` handler is registered as `{ passive: false }` on the icon area and immediately calls `e.preventDefault()` when the touch lands on an icon. This suppresses the native Android long-press gesture (which would otherwise fire `touchcancel` + `contextmenu` at ~500 ms and silently kill the drag). Scrolling on empty area is unaffected — `preventDefault` is only called when a `.file-item` is the touch target, and `.file-item` elements carry `touch-action: none` in CSS to prevent the browser's pan gesture recognizer from competing.

### Multi-file drag

All items in the current selection are dragged simultaneously. Each selected icon follows the same displacement vector as the primary icon. Snap previews are shown for every item in the selection, offset relative to one another to reflect final grid positions.

### Context menu

A short tap (< 350 ms) on an icon opens the context menu. A long press (≥ 400 ms) starts a drag instead of opening the menu. The two actions are mutually exclusive — if the native `contextmenu` event fires while a drag is already active, it is suppressed; if it fires before the drag timer completes, the timer is cancelled.

### Paste at finger position

When **Paste** is triggered from the context menu on a touch device, the items are placed at the position where the menu was opened, rather than defaulting to the origin. The context screen position (`App._ctxScreenPos`) is captured when the menu action is confirmed, and each pasted item is placed via `_snapFreeCell` relative to that position.

### Overscroll

`overscroll-behavior: none` is applied to `.desktop-area` and `.fw-area` to prevent pull-to-refresh and iOS overscroll bounce from interfering with drag gestures.

---

## 🛡️ Container Integrity Scanner

The built-in scanner performs a deep analysis of the virtual disk image, encrypted file table, folder hierarchy, desktop layout, and workspace environment. It runs **27 checks** in two phases:

### Phase 1 — VFS structural checks (21 steps, synchronous)

| #   | Check                        | Repairs                                                                        |
| --- | ---------------------------- | ------------------------------------------------------------------------------ |
| 1   | Root node integrity          | Recreates missing root; fixes type and parentId                                |
| 2   | Node field validation        | Fixes IDs, names, types; restores missing/invalid ctime and mtime to today     |
| 3   | Node ID format validation    | Reassigns malformed IDs; migrates position data                                |
| 4   | Timestamp anomaly detection  | Detects mass-identical ctimes; spreads them across a 1-second window on repair |
| 5   | File name validation         | Sanitizes invalid characters, truncates long names                             |
| 6   | Orphaned node detection      | Reattaches to root                                                             |
| 7   | Parent type validation       | Reattaches nodes whose parent is a file                                        |
| 8   | Parent-child cycle detection | Breaks cycles by reattaching to root                                           |
| 9   | Node reachability analysis   | O(n) memoized; reattaches unreachable nodes                                    |
| 10  | Timestamp integrity          | Fixes invalid/future timestamps                                                |
| 11  | File size validation         | Resets negative/invalid sizes                                                  |
| 12  | File metadata validation     | Strips unknown properties                                                      |
| 13  | Duplicate name detection     | Auto-renames collisions                                                        |
| 14  | Empty folder chain detection | O(n) iterative post-order DFS; informational                                   |
| 15  | Position table cleanup       | Removes stale entries                                                          |
| 16  | Folder position maps         | Creates missing position maps                                                  |
| 17  | Position entry completeness  | Only checks visited (opened) folders; auto-positions on repair                 |
| 18  | Position collision detection | Relocates overlapping icons                                                    |
| 19  | Grid alignment verification  | Snaps off-grid positions                                                       |
| 20  | Folder depth analysis        | O(n) memoized; warns when nesting > 50 levels                                  |
| 21  | Node count summary           | Informational — file/folder/position counts                                    |

### Phase 2 — Database-level checks (6 steps, async)

| #   | Check                      | Repairs                                                                                                             |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | File data existence        | Removes VFS nodes whose encrypted blob is missing from IndexedDB                                                    |
| 2   | Encryption IV integrity    | Accepts Array/Uint8Array/ArrayBuffer (canonical: plain Array); coerces base64 strings; purges only if truly invalid |
| 3   | File blob integrity        | Resets declared size to 0 if blob is empty                                                                          |
| 4   | Orphaned storage records   | Deletes DB records not referenced by any VFS node                                                                   |
| 5   | Record container binding   | Fixes records bound to wrong container ID                                                                           |
| 6   | Container size consistency | Recalculates totalSize from live VFS nodes                                                                          |

Before auto-repair runs, a **confirmation dialog** recommends exporting the container as a `.safenova` backup — you can do this without leaving the scanner. After a successful repair, a verification scan runs automatically to confirm all issues are resolved.

If auto-repair cannot fix the remaining issues, a **Deep Clean** option becomes available. It performs an aggressive structural rebuild in five O(n) passes:

1. Scan DB storage records
2. Purge dead nodes — remove every VFS node with no real encrypted data behind it
3. Flatten deep folder chains — files nested more than 50 levels deep are reparented to their closest ≤50-level ancestor; all file data is preserved
4. Repair metadata — each node with a missing or invalid `ctime`/`mtime` gets today's date
5. Clean storage records — remove orphaned DB entries in a single batch transaction

After Deep Clean, a verification scan runs automatically. A backup is offered before Deep Clean runs, same as for auto-repair.
