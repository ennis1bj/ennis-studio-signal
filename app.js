// Ennis Studio Signal — encrypted, swipeable news feed.
const SERVICES = {
  opportunity: 'AI Opportunity',
  'safe-ai': 'Safe AI Adoption',
  build: 'AI Build Day',
  'build-vs-buy': 'Build vs. Buy',
  diligence: 'Due Diligence',
  research: 'Market Research',
  advisory: 'Fractional Advisor',
  'change-risk': 'Change Risk Intel',
};
const BATCHES_TO_LOAD = 10;
const subtle = crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();
const $ = (s, r = document) => r.querySelector(s);
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- storage ---------- */
const ls = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('sig:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sig:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('sig:' + k); } catch {} },
};
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('es-signal', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = () => rej(tx.error);
  });
}
const keyStore = {
  get: () => idbOp('readonly', (s) => s.get('privateKey')).catch(() => null),
  set: (k) => idbOp('readwrite', (s) => s.put(k, 'privateKey')),
  clear: () => idbOp('readwrite', (s) => s.delete('privateKey')).catch(() => {}),
};

/* ---------- crypto (mirrors scripts/crypto.mjs) ---------- */
async function unwrapPrivate(wrapped, passcode) {
  const base = await subtle.importKey('raw', te.encode(passcode.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(wrapped.salt), iterations: wrapped.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pkcs8 = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(wrapped.iv) }, key, unb64(wrapped.ct));
  return subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}
async function openJSON(sealed, privateKey) {
  const epk = await subtle.importKey('jwk', sealed.epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: epk }, privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64(sealed.salt), info: te.encode('es-signal-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return JSON.parse(td.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.ct))));
}

/* ---------- state ---------- */
const state = {
  key: null,
  cards: [],
  filter: ls.get('filter', 'all'),
  saved: new Set(ls.get('saved', [])),
  seen: new Set(ls.get('seen', [])),
  seenAtLoad: new Set(),
  updated: null,
};

async function getJSON(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/* ---------- lock ---------- */
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const k = await keyStore.get();
  if (k) { state.key = k; return startApp(); }
  showLock();
}
function showLock() {
  $('#app').hidden = true;
  $('#lock').hidden = false;
  setTimeout(() => $('#pass').focus(), 50);
}
$('#lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#unlock-btn'), err = $('#lock-error');
  err.textContent = '';
  btn.disabled = true; btn.textContent = 'Unlocking…';
  try {
    const wrapped = await getJSON('keys/private.enc.json');
    let key;
    try { key = await unwrapPrivate(wrapped, $('#pass').value); }
    catch { throw new Error('That passcode did not work.'); }
    state.key = key;
    if ($('#remember').checked) await keyStore.set(key);
    $('#pass').value = '';
    await startApp();
  } catch (x) {
    err.textContent = x.message.includes('passcode') ? x.message : 'Could not reach the feed. Check your connection and try again.';
  } finally { btn.disabled = false; btn.textContent = 'Unlock'; }
});

/* ---------- load ---------- */
async function loadCards() {
  const index = await getJSON('data/index.json');
  state.updated = index.updated;
  const batches = index.batches.slice(0, BATCHES_TO_LOAD);
  const opened = await Promise.all(batches.map(async (b) => {
    try { return await openJSON(await getJSON(`data/batches/${b.file}`), state.key); }
    catch (e) { console.warn('batch failed', b.file, e); return null; }
  }));
  if (batches.length && opened.every((o) => o === null)) throw new Error('decrypt');
  const seenIds = new Set();
  state.cards = opened.filter(Boolean).flatMap((o) => o.cards).filter((c) => !seenIds.has(c.id) && seenIds.add(c.id));
}

async function startApp() {
  $('#lock').hidden = true;
  $('#app').hidden = false;
  renderSkeleton();
  try { await loadCards(); }
  catch (e) {
    if (e.message === 'decrypt') { await keyStore.clear(); state.key = null; showLock(); $('#lock-error').textContent = 'This device key no longer matches the feed. Enter the passcode again.'; return; }
    renderError(); return;
  }
  state.seenAtLoad = new Set(state.seen);
  render();
}

/* ---------- render ---------- */
const icons = {
  save: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" fill="currentColor" fill-opacity=".0" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  saved: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v7h14v-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  open: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chart: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V4H4v12h4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
};
const fmtDate = (d) => { const [y, m, day] = d.split('-').map(Number); return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

function visibleCards() {
  if (state.filter === 'saved') return state.cards.filter((c) => state.saved.has(c.id));
  if (state.filter === 'seen') return state.cards.filter((c) => state.seen.has(c.id));
  // Cards seen in an earlier session are hidden. Cards seen this session stay put so you can scroll back.
  const fresh = state.cards.filter((c) => !state.seenAtLoad.has(c.id));
  return state.filter === 'all' ? fresh : fresh.filter((c) => c.service === state.filter);
}


/* ---------- infographics ---------- */
const num = (v) => (typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, '')) || 0);
function ring(pct, value) {
  const r = 42, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct));
  return `<svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="${r}" class="ring__track"/>
    <circle cx="50" cy="50" r="${r}" class="ring__fill" stroke-dasharray="${(c * p / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 50 50)"/>
    <text x="50" y="50" class="ring__text" text-anchor="middle" dominant-baseline="central">${esc(value)}</text></svg>`;
}
function visualHTML(v) {
  if (!v) return '';
  const title = v.title ? `<p class="viz__title">${esc(v.title)}</p>` : '';
  if (v.type === 'stat') {
    const body = v.pct != null
      ? `<div class="viz-stat viz-stat--ring">${ring(num(v.pct), v.value)}<p class="viz-stat__label">${esc(v.label)}</p></div>`
      : `<div class="viz-stat"><span class="viz-stat__value">${esc(v.value)}</span><p class="viz-stat__label">${esc(v.label)}</p></div>`;
    return `<figure class="viz">${title}${body}</figure>`;
  }
  if (v.type === 'bars') {
    const max = Math.max(...v.items.map((i) => num(i.value))) || 1;
    const hi = v.highlight ?? v.items.reduce((m, it, i, a) => (num(it.value) > num(a[m].value) ? i : m), 0);
    return `<figure class="viz">${title}<div class="viz-bars">${v.items.map((it, i) => `
      <div class="bar${i === hi ? ' bar--hi' : ''}"><span class="bar__label">${esc(it.label)}</span>
      <span class="bar__track"><span class="bar__fill" style="--w:${Math.max(3, (num(it.value) / max) * 100).toFixed(1)}%"></span></span>
      <span class="bar__val">${esc(it.display ?? `${it.value}${v.unit ?? ''}`)}</span></div>`).join('')}</div></figure>`;
  }
  if (v.type === 'compare') {
    const [a, b] = v.items, total = num(a.value) + num(b.value) || 1;
    return `<figure class="viz">${title}<div class="viz-compare">
      <div class="cmp"><span class="cmp__value">${esc(a.display ?? a.value)}</span><span class="cmp__label">${esc(a.label)}</span></div>
      <span class="cmp__vs" aria-hidden="true">→</span>
      <div class="cmp cmp--hi"><span class="cmp__value">${esc(b.display ?? b.value)}</span><span class="cmp__label">${esc(b.label)}</span></div></div>
      <div class="cmp__split" aria-hidden="true"><span style="flex:${num(a.value) / total}"></span><span style="flex:${num(b.value) / total}"></span></div></figure>`;
  }
  if (v.type === 'timeline') {
    return `<figure class="viz">${title}<ol class="viz-time" style="--n:${v.items.length}">${v.items.map((it, i) => `
      <li class="${i === v.items.length - 1 ? 'is-last' : ''}"><span class="t__dot"></span><span class="t__time">${esc(it.time)}</span><span class="t__label">${esc(it.label)}</span></li>`).join('')}</ol></figure>`;
  }
  if (v.type === 'steps') {
    return `<figure class="viz">${title}<ol class="viz-steps">${v.items.map((it, i) => `<li><span class="s__n">${i + 1}</span><span>${esc(it)}</span></li>`).join('')}</ol></figure>`;
  }
  return '';
}
const cardVisual = (c) => c.visual || (c.figure ? { type: 'stat', value: c.figure.value, label: c.figure.label } : null);

function cardHTML(c, i, total) {
  const saved = state.saved.has(c.id);
  return `<article class="card${cardVisual(c) ? ' has-viz' : ''}" data-id="${esc(c.id)}" data-service="${esc(c.service)}" data-n="${String(i + 1).padStart(2, '0')}" aria-label="Card ${i + 1} of ${total}: ${esc(c.headline)}">
    <div class="card__meta">
      <span class="tag">${esc(SERVICES[c.service] || c.service)}</span><span class="dot"></span>
      <span>${esc(c.source.name)}</span><span class="dot"></span><span>${fmtDate(c.published)}</span>
    </div>
    ${visualHTML(cardVisual(c))}
    <h2 class="card__headline">${esc(c.headline)}</h2>
    <p class="card__summary">${esc(c.summary)}</p>
    <div class="why"><p class="eyebrow">${c.service === 'change-risk' ? 'Why change owners should care' : 'Why it matters for Ennis Studio'}</p><p>${esc(c.why)}</p></div>
    <button class="angle" data-act="angle" aria-label="Copy LinkedIn post angle">${icons.copy}<span><b>Copy LinkedIn post angle</b>${esc(c.angle)}</span></button>
    <div class="rail">
      <button class="act" data-act="save" aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved' : 'Save card'}"><span class="act__icon">${saved ? icons.saved : icons.save}</span><span>${saved ? 'Saved' : 'Save'}</span></button>
      <button class="act" data-act="share" aria-label="Share story"><span class="act__icon">${icons.share}</span><span>Share</span></button>
      ${c.image ? `<button class="act" data-act="chart" aria-label="View full chart"><span class="act__icon">${icons.chart}</span><span>Chart</span></button>` : ''}
      <a class="act" data-act="open" href="${esc(c.source.url)}" target="_blank" rel="noopener" aria-label="Open source article"><span class="act__icon">${icons.open}</span><span>Source</span></a>
    </div>
    ${i === 0 ? '<div class="hint" aria-hidden="true">Swipe up <svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg></div>' : ''}
  </article>`;
}

function endHTML(empty) {
  const updated = state.updated ? new Date(state.updated).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const next = `New cards land every weekday at 7am ET.${updated ? ` Last update ${updated}.` : ''}`;
  const f = state.filter, feedView = f !== 'saved' && f !== 'seen';
  let title, body, act, label;
  if (!empty) { title = 'You’re caught up'; body = feedView ? `Cards you’ve seen won’t show again. ${next}` : next; act = 'top'; label = 'Back to the top'; }
  else if (f === 'saved') { title = 'Nothing saved yet'; body = 'Tap Save on any card to keep it here for a LinkedIn post or client conversation.'; act = 'all'; label = 'Back to the feed'; }
  else if (f === 'seen') { title = 'Nothing seen yet'; body = 'Cards move here once you’ve looked at them.'; act = 'all'; label = 'Back to the feed'; }
  else { title = 'You’re caught up'; body = `You’ve seen every card${f === 'all' ? '' : ' in this service line'}. ${next}`; act = 'seen'; label = 'Review seen cards'; }
  return `<article class="card endcard" data-n="">
    <p class="eyebrow">Ennis Studio Signal</p><h2>${title}</h2><p>${body}</p>
    <button class="btn btn--ghost" data-act="${act}">${label}</button>
  </article>`;
}

function renderSkeleton() {
  $('#feed').innerHTML = `<article class="card skeleton" aria-busy="true" aria-label="Loading">
    <div class="sk" style="width:40%;height:12px"></div><div class="sk" style="width:90%;height:30px"></div><div class="sk" style="width:70%;height:30px"></div>
    <div class="sk" style="width:100%;height:80px;margin-top:8px"></div><div class="sk" style="width:100%;height:56px"></div></article>`;
  $('#counter').textContent = '';
}
function renderError() {
  $('#feed').innerHTML = `<article class="card endcard"><p class="eyebrow">Offline</p><h2>Couldn’t load the feed</h2><p>Check your connection. Cards you've already opened stay available offline.</p><button class="btn btn--ghost" data-act="retry">Try again</button></article>`;
}

let observer;
const dwell = new Map();
const SEEN_DWELL_MS = 1200;
const LABELS = { all: 'All', saved: 'Saved', seen: 'Seen' };
function markSeen(id) {
  if (state.seen.has(id)) return;
  state.seen.delete(id); state.seen.add(id);
  ls.set('seen', [...state.seen].slice(-3000));
}
function render() {
  const list = visibleCards();
  const feed = $('#feed');
  feed.innerHTML = list.map((c, i) => cardHTML(c, i, list.length)).join('') + endHTML(list.length === 0);
  feed.scrollTop = 0;
  $('#filter-label').textContent = LABELS[state.filter] || SERVICES[state.filter];
  updateCounter(list.length ? 1 : 0, list.length);
  observer?.disconnect();
  dwell.forEach(clearTimeout); dwell.clear();
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const el = en.target, id = el.dataset.id;
      if (!en.isIntersecting) { clearTimeout(dwell.get(el)); dwell.delete(el); continue; }
      const idx = [...feed.children].indexOf(el);
      updateCounter(Math.min(idx + 1, list.length), list.length);
      // A card counts as seen after it has been on screen for a moment, not when flicked past.
      if (id && !state.seen.has(id) && !dwell.has(el)) dwell.set(el, setTimeout(() => { dwell.delete(el); markSeen(id); }, SEEN_DWELL_MS));
    }
  }, { root: feed, threshold: 0.6 });
  [...feed.children].forEach((el) => observer.observe(el));
  fitCards();
}
// Shrink any card whose content would run under the top bar (small phones, long summaries).
function fitCards() {
  const limit = $('.topbar').offsetHeight + 4;
  for (const el of $('#feed').querySelectorAll('.card[data-id]')) {
    el.classList.remove('tight', 'tighter', 'tightest');
    for (const cls of ['tight', 'tighter', 'tightest']) {
      if (el.firstElementChild.offsetTop >= limit) break;
      el.classList.add(cls);
    }
  }
}
let fitT;
addEventListener('resize', () => { clearTimeout(fitT); fitT = setTimeout(fitCards, 150); });
function updateCounter(i, n) { $('#counter').textContent = n ? `${i} / ${n}` : ''; }

/* ---------- actions ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); }
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { const ta = Object.assign(document.createElement('textarea'), { value: text }); document.body.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; }
}
$('#feed').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const cardEl = btn.closest('.card');
  const c = state.cards.find((x) => x.id === cardEl?.dataset.id);
  const act = btn.dataset.act;
  if (act === 'top') return $('#feed').scrollTo({ top: 0, behavior: 'smooth' });
  if (act === 'all') { setFilter('all'); return; }
  if (act === 'seen') { setFilter('seen'); return; }
  if (act === 'retry') return startApp();
  if (!c) return;
  if (act === 'save') {
    const on = !state.saved.has(c.id);
    on ? state.saved.add(c.id) : state.saved.delete(c.id);
    ls.set('saved', [...state.saved]);
    btn.setAttribute('aria-pressed', on);
    btn.setAttribute('aria-label', on ? 'Remove from saved' : 'Save card');
    btn.innerHTML = `<span class="act__icon">${on ? icons.saved : icons.save}</span><span>${on ? 'Saved' : 'Save'}</span>`;
    toast(on ? 'Saved' : 'Removed from saved');
  } else if (act === 'angle') {
    const text = `${c.angle}\n\n${c.source.url}`;
    toast((await copy(text)) ? 'Post angle copied' : 'Copy failed');
  } else if (act === 'chart') {
    openLightbox(c.image.src, c.image.alt || c.headline);
  } else if (act === 'share') {
    const data = { title: c.headline, text: c.summary, url: c.source.url };
    if (navigator.share) { try { await navigator.share(data); } catch {} }
    else toast((await copy(`${c.headline}\n${c.source.url}`)) ? 'Link copied' : 'Copy failed');
  }
});

/* ---------- chart lightbox ---------- */
function openLightbox(src, alt) {
  const lb = $('#lightbox');
  $('#lightbox-img').src = src; $('#lightbox-img').alt = alt;
  lb.hidden = false; $('#lightbox-close').focus();
}
function closeLightbox() { $('#lightbox').hidden = true; $('#lightbox-img').removeAttribute('src'); }
$('#lightbox').addEventListener('click', (e) => { if (e.target.closest('#lightbox-close') || e.target === $('#lightbox') || e.target.matches('.lightbox__scroll')) closeLightbox(); });

/* ---------- filter sheet ---------- */
function setFilter(f) { state.filter = f; ls.set('filter', f); closeSheet(); render(); }
function openSheet() {
  const fresh = state.cards.filter((c) => !state.seenAtLoad.has(c.id));
  const counts = { all: fresh.length, saved: state.cards.filter((c) => state.saved.has(c.id)).length, seen: state.cards.filter((c) => state.seen.has(c.id)).length };
  for (const c of fresh) counts[c.service] = (counts[c.service] || 0) + 1;
  const opts = [['all', 'All'], ['saved', 'Saved'], ['seen', 'Seen'], ...Object.entries(SERVICES)];
  $('#chips').innerHTML = opts.filter(([k]) => k in LABELS || counts[k])
    .map(([k, label]) => `<button class="chip" data-f="${k}" aria-pressed="${state.filter === k}">${label}<span>${counts[k] || 0}</span></button>`).join('');
  const unseen = state.cards.filter((c) => !state.seen.has(c.id)).length;
  $('#sheet-meta').textContent = `${unseen} unread of ${state.cards.length} cards from the last ${BATCHES_TO_LOAD} batches. Seen cards are hidden from the feed on this device.`;
  $('#reset-seen-btn').hidden = state.seen.size === 0;
  $('#sheet').hidden = false;
  $('#chips button')?.focus();
}
function closeSheet() { $('#sheet').hidden = true; $('#filter-btn').focus(); }
$('#filter-btn').addEventListener('click', openSheet);
$('#sheet').addEventListener('click', (e) => {
  if (e.target.matches('[data-close]')) return closeSheet();
  const chip = e.target.closest('[data-f]');
  if (chip) setFilter(chip.dataset.f);
});
$('#reset-seen-btn').addEventListener('click', () => {
  state.seen.clear(); state.seenAtLoad = new Set(); ls.del('seen');
  state.filter = 'all'; ls.set('filter', 'all'); closeSheet(); render(); toast('All cards marked unread');
});
$('#refresh-btn').addEventListener('click', async () => { closeSheet(); await startApp(); toast('Feed refreshed'); });
$('#lock-btn').addEventListener('click', async () => { await keyStore.clear(); state.key = null; state.cards = []; $('#sheet').hidden = true; showLock(); });
$('#to-top').addEventListener('click', () => $('#feed').scrollTo({ top: 0, behavior: 'smooth' }));

document.addEventListener('keydown', (e) => {
  if (!$('#lightbox').hidden) { if (e.key === 'Escape') closeLightbox(); return; }
  if (!$('#sheet').hidden) { if (e.key === 'Escape') closeSheet(); return; }
  if ($('#app').hidden || e.target.matches('input, textarea')) return;
  const feed = $('#feed'), h = feed.clientHeight;
  if (['ArrowDown', 'j', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); feed.scrollBy({ top: h, behavior: 'smooth' }); }
  if (['ArrowUp', 'k', 'PageUp'].includes(e.key)) { e.preventDefault(); feed.scrollBy({ top: -h, behavior: 'smooth' }); }
  if (e.key === 's') feed.children[Math.round(feed.scrollTop / h)]?.querySelector('[data-act="save"]')?.click();
});
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  if (!state.key || $('#app').hidden) return;
  // Pick up a new morning batch when the app comes back to the foreground.
  getJSON('data/index.json').then((ix) => {
    if (ix.updated !== state.updated) { startApp(); toast('New cards loaded'); }
    // Back after a break with no new batch: drop the cards seen last time.
    else if (hiddenAt && Date.now() - hiddenAt > 15 * 60e3 && !['saved', 'seen'].includes(state.filter)) { state.seenAtLoad = new Set(state.seen); render(); }
  }).catch(() => {});
});

boot();
