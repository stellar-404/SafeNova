'use strict';

/* ============================================================
   SESSION ENCRYPTION  —  AES-256-GCM encrypted session storage

   Design:
   • The 32-byte session key is generated once and kept in
     sessionStorage ('snv-sk'). It never touches localStorage.
   • Tab-scope sessions  → snv-s-{cid}  in sessionStorage.
   • Browser-scope sessions → snv-sb-{cid} in localStorage.
   • When the browser closes, sessionStorage is wiped → the key
     is gone → any localStorage blobs become undecryptable.
   • An attacker who dumps only localStorage cannot recover
     passwords without also reading the current sessionStorage.
   ============================================================ */
let _sessionKey = null;

async function _getOrCreateSessionKey() {
    if (_sessionKey) return _sessionKey;
    const stored = sessionStorage.getItem('snv-sk');
    if (stored) {
        try {
            const raw = Uint8Array.from(atob(stored), ch => ch.charCodeAt(0));
            _sessionKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
            return _sessionKey;
        } catch { /* corrupted — regenerate below */ }
    }
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const exp = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    const exported = await crypto.subtle.exportKey('raw', exp);
    sessionStorage.setItem('snv-sk', btoa(String.fromCharCode(...new Uint8Array(exported))));
    // Re-import as non-extractable for forward secrecy within this session
    _sessionKey = await crypto.subtle.importKey('raw', exported, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return _sessionKey;
}

// Browser-scope sessions expire after 7 days; tab-scope persist until tab closes
const SESSION_TTL_BROWSER = 7 * 24 * 60 * 60 * 1000;

// rawKeyBytes — Uint8Array(32) from Crypto.deriveRaw(), never the plaintext password
async function saveSession(cid, rawKeyBytes, scope) {
    const key = await _getOrCreateSessionKey(),
        iv = crypto.getRandomValues(new Uint8Array(12));
    const expiryMs = scope === 'browser' ? Date.now() + SESSION_TTL_BROWSER : Number.MAX_SAFE_INTEGER;
    const payload = new Uint8Array(8 + rawKeyBytes.length);
    new DataView(payload.buffer).setBigUint64(0, BigInt(expiryMs), true);
    payload.set(rawKeyBytes, 8);
    const aad = new TextEncoder().encode('snv-session:' + cid);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, payload);
    const blob = new Uint8Array(12 + ct.byteLength);
    blob.set(iv);
    blob.set(new Uint8Array(ct), 12);
    const b64 = btoa(String.fromCharCode(...blob));
    if (scope === 'browser') {
        localStorage.setItem('snv-sb-' + cid, b64);
        sessionStorage.removeItem('snv-s-' + cid);
    } else {
        sessionStorage.setItem('snv-s-' + cid, b64);
        localStorage.removeItem('snv-sb-' + cid);
    }
}

// Returns Uint8Array(32) raw key bytes on success, or null on failure/expiry
async function loadSession(cid) {
    const b64 = sessionStorage.getItem('snv-s-' + cid) || localStorage.getItem('snv-sb-' + cid);
    if (!b64) return null;
    try {
        const key = await _getOrCreateSessionKey(),
            blob = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)),
            iv = blob.slice(0, 12),
            ct = blob.slice(12),
            aad = new TextEncoder().encode('snv-session:' + cid),
            dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ct);
        const payload = new Uint8Array(dec);
        const expiry = Number(new DataView(payload.buffer).getBigUint64(0, true));
        if (Date.now() > expiry) { clearSession(cid); return null; }
        return payload.slice(8); // 32-byte raw key material
    } catch { clearSession(cid); return null; }
}

function clearSession(cid) {
    sessionStorage.removeItem('snv-s-' + cid);
    localStorage.removeItem('snv-sb-' + cid);
}

function hasSession(cid) {
    return !!(sessionStorage.getItem('snv-s-' + cid) || localStorage.getItem('snv-sb-' + cid));
}

/* ============================================================
   APP STATE
   ============================================================ */
const App = {
    view: 'home',
    container: null,   // container metadata object
    key: null,   // CryptoKey (in-memory only, never persisted)
    folder: 'root',
    selection: new Set(),
    clipboard: null,   // { op: 'copy'|'cut', ids: [...] }
    thumbCache: {},    // nodeId → dataURL
    _winCtx: null,   // active FolderWindow context (set by FolderWindow ops)
    _ctxScreenPos: null, // screen {x,y} of last context-menu click (used to position new files/folders)

    async init() {
        if (!window.isSecureContext || !window.crypto?.subtle) {
            const ol = document.getElementById('loading-overlay');
            if (ol) {
                const reason = !window.isSecureContext
                    ? 'Open this page over <strong style="color:var(--text)">HTTPS</strong> or <code style="color:var(--accent);font-family:monospace">localhost</code>.'
                    : 'This browser does not support the Web Crypto API.';
                ol.innerHTML = `
          <div style="text-align:center;max-width:380px;padding:0 24px">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" style="color:#f44747;margin-bottom:16px" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 20h20z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M12 9v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <circle cx="12" cy="16.5" r="0.8" fill="currentColor"/>
            </svg>
            <div style="color:var(--text);font-size:16px;font-weight:600;margin-bottom:8px">Web Crypto API unavailable</div>
            <div style="color:var(--text-dim);font-size:13px;line-height:1.7">${reason}<br>Use Chrome, Firefox, or Edge.</div>
          </div>`;
                ol.style.cssText += 'display:flex;opacity:1;pointer-events:all;';
            }
            return;
        }
        await DB.init();
        this.showView('home');
        await Home.render();
        await updateStorageInfo();
    },

    showView(name) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + name).classList.add('active');
        this.view = name;
    },

    // Return to home WITHOUT killing the session (password stays remembered)
    async backToMenu() {
        this.key = null;
        this.container = null;
        this.folder = 'root';
        this.selection = new Set();
        this.clipboard = null;
        this.thumbCache = {};
        this._winCtx = null;
        if (typeof WinManager !== 'undefined') WinManager.closeAll();
        if (typeof _resetContainerSettings === 'function') _resetContainerSettings();
        if (typeof Desktop !== 'undefined') {
            Desktop._desktopFolder = 'root';
            Desktop._sel = this.selection;
        }
        VFS.init();
        this.showView('home');
        await Home.render();
        await updateStorageInfo();
    },

    async lockContainer() {
        const cid = this.container?.id;
        if (cid) clearSession(cid);
        this.key = null;
        this.container = null;
        this.folder = 'root';
        this.selection = new Set();
        this.clipboard = null;
        this.thumbCache = {};
        this._winCtx = null;
        // Close all open folder windows
        if (typeof WinManager !== 'undefined') WinManager.closeAll();
        if (typeof _resetContainerSettings === 'function') _resetContainerSettings();
        // Keep remembered sessions intact — "Back to menu" should not kill stored passwords
        // Reset desktop folder tracking
        if (typeof Desktop !== 'undefined') {
            Desktop._desktopFolder = 'root';
            Desktop._sel = this.selection;
        }
        VFS.init();
        this.showView('home');
        await Home.render();
        await updateStorageInfo();
    }
};

/* ============================================================
   LOADING OVERLAY
   ============================================================ */
function showLoading(msg = 'Processing...') {
    document.getElementById('loading-msg').textContent = msg;
    document.getElementById('loading-overlay').classList.add('show');
}
function hideLoading() {
    document.getElementById('loading-overlay').classList.remove('show');
}

/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */
function toast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    const iconMap = {
        success: Icons.info,
        error: Icons.warning,
        warn: Icons.warning,
        info: Icons.info,
    };
    t.innerHTML = `<span style="color:var(--text-dim)">${iconMap[type] || ''}</span><span>${escHtml(msg)}</span>`;
    document.getElementById('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 3200);
}

/* ============================================================
   MODAL OVERLAY HELPER
   ============================================================ */
const Overlay = {
    current: null,
    _hideTimer: null,

    show(modalId) {
        // Cancel any pending hide so the modal doesn't get wiped by a deferred setTimeout
        if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
        const ov = document.getElementById('modal-overlay');
        ov.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
        const m = document.getElementById(modalId);
        if (m) m.style.display = 'flex';
        ov.classList.add('show');
        this.current = modalId;
    },

    hide() {
        document.getElementById('modal-overlay').classList.remove('show');
        this._hideTimer = setTimeout(() => {
            this._hideTimer = null;
            document.getElementById('modal-overlay')
                .querySelectorAll('.modal').forEach(m => m.style.display = 'none');
        }, 200);
        this.current = null;
        // If cancelled from a FolderWindow context — restore main desktop state
        if (App._winCtx !== null) {
            App._winCtx = null;
            if (typeof Desktop !== 'undefined') {
                App.folder = Desktop._desktopFolder;
                App.selection = Desktop._sel;
            }
        }
    }
};

/* ============================================================
   STORAGE INFO  —  20 GB device limit + low-space warnings
   ============================================================ */
let _storageWarnShown = false;

async function updateStorageInfo() {
    try {
        if (!navigator.storage?.estimate) return;
        const est = await navigator.storage.estimate();
        const used = est.usage || 0,
            quota = est.quota || 0,
            available = quota - used;

        // Cap the visual scale at DEVICE_LIMIT (20 GB)
        const displayMax = Math.min(quota > 0 ? quota : DEVICE_LIMIT, DEVICE_LIMIT),
            pct = displayMax > 0 ? Math.min((used / displayMax) * 100, 100) : 0;

        const fill = document.getElementById('storage-bar-fill');
        const txt = document.getElementById('storage-text');
        if (fill) {
            fill.style.width = pct + '%';
            fill.className = 'storage-bar-fill' + (pct > 90 ? ' danger' : pct > 70 ? ' warn' : '');
        }
        if (txt) txt.textContent = `${fmtSize(used)} / ${fmtSize(displayMax)}  ·  ${fmtSize(available)} free`;

        // Storage warning banner
        const banner = document.getElementById('storage-warning-banner');
        if (banner) {
            if (available < 200 * 1024 * 1024) {        // < 200 MB
                banner.querySelector('span').textContent =
                    `Critical: only ${fmtSize(available)} of storage remaining on this device. Data may not be saved.`;
                banner.classList.add('show');
            } else if (available < 1 * 1024 * 1024 * 1024) { // < 1 GB
                banner.querySelector('span').textContent =
                    `Low storage: ${fmtSize(available)} remaining on this device.`;
                banner.classList.add('show');
            } else {
                banner.classList.remove('show');
            }
        }

        // One-time toast for low storage
        if (!_storageWarnShown && available < 500 * 1024 * 1024) {
            _storageWarnShown = true;
            if (available < 100 * 1024 * 1024) {
                toast(`Critical: only ${fmtSize(available)} free on this device!`, 'error');
            } else {
                toast(`Low storage: ${fmtSize(available)} remaining.`, 'warn');
            }
        }

        // TrueWebCrypt containers usage
        const containers = await DB.getContainers();
        const twcUsed = containers.reduce((s, c) => s + (c.totalSize || 0), 0);
        const twcPct = displayMax > 0 ? Math.min((twcUsed / displayMax) * 100, 100) : 0;
        const twcFill = document.getElementById('twc-bar-fill');
        const twcTxt = document.getElementById('twc-text');
        if (twcFill) twcFill.style.width = twcPct + '%';
        if (twcTxt) twcTxt.textContent = `${fmtSize(twcUsed)} in ${containers.length} container${containers.length !== 1 ? 's' : ''}`;
    } catch (e) { /* silently ignore — storage API may be restricted */ }
}

/* ============================================================
   CHECK DEVICE STORAGE BEFORE WRITE
   Returns { ok: bool, available: number }
   ============================================================ */
async function checkStorageSpace(needed) {
    try {
        if (!navigator.storage?.estimate) return { ok: true, available: Infinity };
        const est = await navigator.storage.estimate(),
            available = (est.quota || 0) - (est.usage || 0);
        // Keep 50 MB safety margin
        if (available - needed < 50 * 1024 * 1024) {
            return { ok: false, available };
        }
        return { ok: true, available };
    } catch { return { ok: true, available: Infinity }; }
}
