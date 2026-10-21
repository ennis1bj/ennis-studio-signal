// Create a new keypair and wrap the private key with a passcode.
// Usage: SIGNAL_PASSCODE="..." node scripts/init-keys.mjs [--force]
// WARNING: a new keypair makes previously published batches unreadable. To change only the
// passcode, use scripts/rotate-passcode.mjs instead.
import { writeFile, access } from 'node:fs/promises';
import { wrapPrivate } from './crypto.mjs';

const pass = process.env.SIGNAL_PASSCODE;
if (!pass || pass.length < 12) { console.error('Set SIGNAL_PASSCODE (12+ chars).'); process.exit(1); }
try { await access('keys/public.json'); if (!process.argv.includes('--force')) { console.error('keys/public.json exists. Use --force to replace (old batches become unreadable).'); process.exit(1); } } catch {}
const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
await writeFile('keys/public.json', JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, null, 2) + '\n');
await writeFile('keys/private.enc.json', JSON.stringify(await wrapPrivate(kp.privateKey, pass), null, 2) + '\n');
console.log('Wrote keys/public.json and keys/private.enc.json');
