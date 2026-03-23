'use strict';

/* ============================================================
   CRYPTO  —  AES-256-GCM + Argon2id (WASM)
   ============================================================ */
const Crypto = (() => {

    const IV_LENGTH = 12;

    // Returns raw 32-byte Argon2id hash as Uint8Array
    async function deriveRaw(password, salt) {
        // Normalize password input to Uint8Array for safe wiping
        let passBytes = null;
        if (password instanceof Uint8Array) {
            passBytes = new Uint8Array(password);
        } else if (password instanceof ArrayBuffer) {
            passBytes = new Uint8Array(password.slice(0));
        } else {
            passBytes = new TextEncoder().encode(String(password || ''));
        }
        try {
            return await hashwasm.argon2id({
                password: passBytes,
                salt,
                parallelism: ARGON2_PAR,
                iterations: ARGON2_ITER,
                memorySize: ARGON2_MEM,
                hashLength: 32,
                outputType: 'binary',
            });
        } finally {
            passBytes.fill(0);
        }
    }

    async function deriveKey(password, salt) {
        let hash = null;
        try {
            hash = await deriveRaw(password, salt);
            return await crypto.subtle.importKey(
                'raw', hash,
                { name: 'AES-GCM' },
                false,
                ['encrypt', 'decrypt']
            );
        } finally {
            if (hash && typeof hash.fill === 'function') hash.fill(0);
        }
    }

    // Derives both the CryptoKey and the raw bytes in a single Argon2id pass.
    // Use instead of calling deriveKey + deriveRaw separately to avoid double hashing.
    async function deriveKeyAndRaw(password, salt) {
        const raw = await deriveRaw(password, salt),
            key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        return { key, raw };
    }

    // Import a pre-derived 32-byte key (skips Argon2id for session resume)
    async function importRawKey(rawBytes) {
        return crypto.subtle.importKey(
            'raw', rawBytes,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async function encrypt(key, data) {
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        let buf = null, shouldWipeBuf = false;
        if (data instanceof ArrayBuffer) buf = data;
        else if (data instanceof Uint8Array) {
            const fullView = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
            buf = fullView
                ? data.buffer
                : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            shouldWipeBuf = !fullView;
        }
        else {
            buf = new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data));
            shouldWipeBuf = true;
        }
        try {
            const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf);
            return { iv: Array.from(iv), blob: buf2b64(ct) };
        } finally {
            if (shouldWipeBuf && buf) new Uint8Array(buf).fill(0);
        }
    }

    async function decrypt(key, iv, blobB64) {
        if (!Array.isArray(iv) || iv.length !== IV_LENGTH) throw new Error('Invalid IV');
        const ivU8 = new Uint8Array(iv),
            buf = b642buf(blobB64);
        try {
            return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivU8 }, key, buf);
        } finally {
            new Uint8Array(buf).fill(0);
        }
    }

    async function encryptBin(key, buf) {
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        if (!(buf instanceof ArrayBuffer) && !(buf instanceof Uint8Array)) {
            throw new Error('Invalid plaintext buffer');
        }
        let copied = null;
        const input = buf instanceof Uint8Array
            ? (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
                ? buf.buffer
                : (copied = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)))
            : buf;
        try {
            const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, input);
            return { iv: Array.from(iv), blob: ct };
        } finally {
            if (copied) new Uint8Array(copied).fill(0);
        }
    }

    async function decryptBin(key, iv, blob) {
        if (!iv || iv.length !== IV_LENGTH) throw new Error('Invalid IV');
        if (!(blob instanceof ArrayBuffer) && !(blob instanceof Uint8Array)) throw new Error('Invalid ciphertext buffer');
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, blob);
    }

    async function makeVerification(key) {
        const { iv, blob } = await encrypt(key, VERIFY_TEXT);
        return { iv, blob };
    }

    async function checkVerification(key, iv, blob) {
        let buf = null;
        try {
            buf = await decrypt(key, iv, blob);
            return new TextDecoder().decode(buf) === VERIFY_TEXT;
        } catch {
            return false;
        } finally {
            if (buf) new Uint8Array(buf).fill(0);
        }
    }

    return { deriveRaw, deriveKey, deriveKeyAndRaw, importRawKey, encrypt, decrypt, encryptBin, decryptBin, makeVerification, checkVerification };
})();
