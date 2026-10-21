// Change the unlock passcode without touching published batches.
// Usage: OLD_PASSCODE="..." NEW_PASSCODE="..." node scripts/rotate-passcode.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { unwrapPrivate, wrapPrivate } from './crypto.mjs';

const { OLD_PASSCODE: oldP, NEW_PASSCODE: newP } = process.env;
if (!oldP || !newP || newP.length < 12) { console.error('Set OLD_PASSCODE and NEW_PASSCODE (12+ chars).'); process.exit(1); }
const wrapped = JSON.parse(await readFile('keys/private.enc.json', 'utf8'));
const priv = await unwrapPrivate(wrapped, oldP, true);
await writeFile('keys/private.enc.json', JSON.stringify(await wrapPrivate(priv, newP), null, 2) + '\n');
console.log('Passcode rotated. Commit keys/private.enc.json; devices that chose "remember" stay unlocked.');
