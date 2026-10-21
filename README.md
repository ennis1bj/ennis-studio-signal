# Ennis Studio Signal

A private, installable PWA with a TikTok-style vertical feed of AI advisory news curated for Ennis Studio's service lines. A Perplexity automation researches the news each weekday morning, writes short cards, encrypts them and commits them here. GitHub Pages serves the app.

App: https://ennis1bj.github.io/ennis-studio-signal/

## Privacy model

The repo is public (GitHub Free plan), so everything in `data/` is encrypted.

- `keys/public.json` is an ECDH P-256 public key. Publishing seals each batch to this key (ephemeral ECDH, HKDF-SHA256, AES-256-GCM). **Publishing needs no secret.**
- `keys/private.enc.json` is the matching private key, wrapped with the passcode (PBKDF2-SHA256, 600k iterations, AES-256-GCM). Only the passcode can unwrap it.
- On unlock, the browser derives the private key and (if "Keep this device unlocked" is on) stores it in IndexedDB as a **non-extractable** CryptoKey. "Lock and forget device" deletes it.
- `data/index.json` (batch dates and counts) and `data/seen.json` (truncated SHA-256 hashes of source URLs, for de-duplication) are plaintext but reveal no content.

Never commit plaintext card files. `.gitignore` blocks `cards*.json`.

### Change the passcode

```bash
OLD_PASSCODE='...' NEW_PASSCODE='...' node scripts/rotate-passcode.mjs
git commit -am "Rotate passcode" && git push
```

Existing batches stay readable. `scripts/init-keys.mjs --force` creates a brand-new keypair and makes old batches unreadable, so only use it if the key is compromised.

## Publishing a batch (automation contract)

1. Research the past 24–72 hours of news. Write a JSON array of 8–14 cards to a temp file **outside the repo** (e.g. `/tmp/cards.json`).
2. `node scripts/publish.mjs /tmp/cards.json`. It validates, skips URLs already published, encrypts to `data/batches/YYYY-MM-DD.json`, updates `data/index.json` and `data/seen.json`, and prunes batches older than the newest 45.
3. `git add data && git commit -m "Signal batch YYYY-MM-DD (N cards)" && git push`. Pages redeploys in about a minute.

Exit codes: `2` means validation failed (fix the cards and rerun), and `3` means every card was a duplicate (find fresher stories).

### Card schema

```json
{
  "headline": "≤16 words, specific, no clickbait",
  "summary": "≤60 words: what happened, with concrete numbers",
  "why": "≤35 words: why it matters for Ennis Studio buyers or offers",
  "angle": "≤35 words: a LinkedIn post hook in Ben's voice",
  "service": "opportunity | safe-ai | build | build-vs-buy | diligence | research | advisory",
  "figure": { "value": "≤8 chars, e.g. 13%", "label": "short label" },
  "tags": ["≤4 short tags"],
  "published": "YYYY-MM-DD (source publish date)",
  "source": { "name": "Publication", "url": "https://direct-article-url" }
}
```

`figure` and `tags` are optional. Use a figure only when the story has one real headline number.

| service | Ennis Studio offer |
|--|--|
| `opportunity` | AI Opportunity Workshop: executive initiatives, ROI, prioritization |
| `safe-ai` | Safe AI Adoption Workshop: governance, regulation, security, shadow AI |
| `build` | AI Build Day / Implementation Sprint: agents, MCP, architecture |
| `build-vs-buy` | Build vs. Buy Brief: suite vs. point tools, pricing, lock-in |
| `diligence` | Technical Due Diligence Brief: M&A, vendor risk, funding |
| `research` | Market & Competitor Research Sprint: surveys, market data |
| `advisory` | Fractional AI Advisor: operating models, consulting market, leadership |

## Local dev

```bash
python3 -m http.server 8765   # then open http://127.0.0.1:8765
```
