// Shared hybrid encryption for Ennis Studio Signal.
// Feed batches are sealed to an ECDH P-256 public key (ephemeral ECDH + HKDF-SHA256 + AES-GCM).
// The matching private key is stored wrapped with a passcode (PBKDF2-SHA256 + AES-GCM).
// The curation automation only ever needs keys/public.json — no secret is required to publish.
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
export const INFO = enc.encode('es-signal-v1');
export const PBKDF2_ITERATIONS = 600000;

export const b64 = (buf) => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString('base64');
export const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

export async function sealJSON(obj, publicJwk) {
  const recipient = await subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  const epk = await subtle.exportKey('jwk', eph.publicKey);
  return { v: 1, epk: { kty: epk.kty, crv: epk.crv, x: epk.x, y: epk.y }, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function openJSON(sealed, privateKey) {
  const epk = await subtle.importKey('jwk', sealed.epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: epk }, privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64(sealed.salt), info: INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.ct));
  return JSON.parse(dec.decode(pt));
}

async function passKey(passcode, salt, iterations, usage) {
  const base = await subtle.importKey('raw', enc.encode(passcode.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

export async function wrapPrivate(privateKey, passcode) {
  const pkcs8 = await subtle.exportKey('pkcs8', privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passKey(passcode, salt, PBKDF2_ITERATIONS, 'encrypt');
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, pkcs8);
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function unwrapPrivate(wrapped, passcode, extractable = false) {
  const key = await passKey(passcode, unb64(wrapped.salt), wrapped.iterations, 'decrypt');
  const pkcs8 = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(wrapped.iv) }, key, unb64(wrapped.ct));
  return subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveBits']);
}
