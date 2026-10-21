// Validate, de-duplicate, encrypt and index a batch of curated cards.
// Usage: node scripts/publish.mjs path/to/cards.json [--date YYYY-MM-DD] [--dry-run]
// Input: a JSON array of cards (see README for the schema). Never commit the plaintext input.
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sealJSON } from './crypto.mjs';

export const SERVICES = ['opportunity', 'safe-ai', 'build', 'build-vs-buy', 'diligence', 'research', 'advisory', 'change-risk'];
const MAX_BATCHES = 45; // ~9 weeks of weekday batches
const words = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;

export function normUrl(u) {
  const url = new URL(u);
  url.hash = '';
  for (const k of [...url.searchParams.keys()]) if (/^(utm_|ref$|fbclid|gclid|mc_)/i.test(k)) url.searchParams.delete(k);
  return (url.host.replace(/^www\./, '') + url.pathname.replace(/\/$/, '') + (url.search || '')).toLowerCase();
}
export const urlHash = (u) => createHash('sha256').update(normUrl(u)).digest('hex').slice(0, 20);

const short = (s, n) => typeof s === 'string' && s.length > 0 && s.length <= n;
export function validateVisual(v) {
  const e = [], items = v.items;
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  if (v.title && !short(v.title, 48)) e.push('visual.title must be <=48 chars');
  switch (v.type) {
    case 'stat':
      if (!short(String(v.value ?? ''), 8)) e.push('stat.value required (<=8 chars)');
      if (!short(v.label, 70)) e.push('stat.label required (<=70 chars)');
      if (v.pct != null && (!isNum(v.pct) || v.pct < 0 || v.pct > 100)) e.push('stat.pct must be 0-100');
      break;
    case 'bars':
      if (!Array.isArray(items) || items.length < 2 || items.length > 5) e.push('bars needs 2-5 items');
      else items.forEach((it, j) => { if (!short(it.label, 40) || !isNum(it.value)) e.push(`bars item ${j + 1} needs label (<=40) and numeric value`); });
      break;
    case 'compare':
      if (!Array.isArray(items) || items.length !== 2) e.push('compare needs exactly 2 items');
      else items.forEach((it, j) => { if (!short(it.label, 32) || !isNum(it.value) || (it.display && !short(it.display, 8))) e.push(`compare item ${j + 1} needs label (<=32), numeric value, display <=8`); });
      break;
    case 'timeline':
      if (!Array.isArray(items) || items.length < 3 || items.length > 4) e.push('timeline needs 3-4 items');
      else items.forEach((it, j) => { if (!short(it.time, 8) || !short(it.label, 34)) e.push(`timeline item ${j + 1} needs time (<=8) and label (<=34)`); });
      break;
    case 'steps':
      if (!Array.isArray(items) || items.length < 2 || items.length > 4 || !items.every((x) => short(x, 40))) e.push('steps needs 2-4 strings of <=40 chars');
      break;
    default: e.push('visual.type must be stat | bars | compare | timeline | steps');
  }
  return e.map((m) => 'visual: ' + m);
}

export function validate(card, i) {
  const e = [];
  const need = (k) => { if (!card[k] || typeof card[k] !== 'string') e.push(`${k} missing`); };
  ['headline', 'summary', 'why', 'angle', 'service', 'published'].forEach(need);
  if (!card.source?.name || !card.source?.url) e.push('source.name/url missing');
  else { try { const u = new URL(card.source.url); if (!/^https?:$/.test(u.protocol)) e.push('source.url not http(s)'); } catch { e.push('source.url invalid'); } }
  if (card.service && !SERVICES.includes(card.service)) e.push(`service must be one of ${SERVICES.join(', ')}`);
  if (words(card.headline) > 16) e.push('headline > 16 words');
  if (words(card.summary) > 60) e.push('summary > 60 words');
  if (words(card.why) > 35) e.push('why > 35 words');
  if (words(card.angle) > 35) e.push('angle > 35 words');
  if (card.published && !/^\d{4}-\d{2}-\d{2}$/.test(card.published)) e.push('published must be YYYY-MM-DD');
  if (card.figure && (!card.figure.value || !card.figure.label || String(card.figure.value).length > 8)) e.push('figure needs value (<=8 chars) and label');
  if (card.visual) e.push(...validateVisual(card.visual));
  if (card.image) { try { if (new URL(card.image.src).protocol !== 'https:') e.push('image.src must be https'); } catch { e.push('image.src invalid'); } }
  if (card.tags && (!Array.isArray(card.tags) || card.tags.length > 4)) e.push('tags must be an array of <=4');
  return e.map((m) => `card ${i + 1} (${(card.headline || '').slice(0, 40)}): ${m}`);
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const dry = args.includes('--dry-run');
  const di = args.indexOf('--date');
  const date = di >= 0 ? args[di + 1] : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Detroit' });
  if (!file) { console.error('Usage: node scripts/publish.mjs cards.json [--date YYYY-MM-DD] [--dry-run]'); process.exit(1); }

  const cards = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(cards) || !cards.length) { console.error('Input must be a non-empty JSON array.'); process.exit(1); }
  const errors = cards.flatMap(validate);
  if (errors.length) { console.error(errors.join('\n')); process.exit(2); }

  const seen = JSON.parse(await readFile('data/seen.json', 'utf8').catch(() => '{"hashes":[]}'));
  const seenSet = new Set(seen.hashes);
  const fresh = [];
  for (const c of cards) {
    const h = urlHash(c.source.url);
    if (seenSet.has(h)) { console.warn(`skip duplicate: ${c.source.url}`); continue; }
    seenSet.add(h);
    fresh.push({ id: `${date}-${h.slice(0, 8)}`, ...c, curated: date });
  }
  if (!fresh.length) { console.error('Every card was already published. Nothing to do.'); process.exit(3); }

  const index = JSON.parse(await readFile('data/index.json', 'utf8').catch(() => '{"batches":[]}'));
  let name = `${date}.json`, n = 2;
  while (index.batches.some((b) => b.file === name)) name = `${date}-${n++}.json`;
  if (dry) { console.log(`dry run ok: ${fresh.length} cards -> data/batches/${name}`); return; }

  const pub = JSON.parse(await readFile('keys/public.json', 'utf8'));
  await writeFile(`data/batches/${name}`, JSON.stringify(await sealJSON({ date, cards: fresh }, pub)) + '\n');
  index.batches.unshift({ file: name, date, count: fresh.length });
  const keep = index.batches.slice(0, MAX_BATCHES);
  const keepFiles = new Set(keep.map((b) => b.file));
  for (const f of await readdir('data/batches')) if (f.endsWith('.json') && !keepFiles.has(f)) await unlink(`data/batches/${f}`);
  index.batches = keep;
  index.updated = new Date().toISOString();
  await writeFile('data/index.json', JSON.stringify(index, null, 2) + '\n');
  seen.hashes = [...seenSet].slice(-3000);
  await writeFile('data/seen.json', JSON.stringify(seen) + '\n');
  console.log(`published ${fresh.length} cards -> data/batches/${name} (skipped ${cards.length - fresh.length})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
