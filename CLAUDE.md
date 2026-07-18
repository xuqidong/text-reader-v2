# Text Reader

A local-first Progressive Web App for reading Chinese and English TXT books. Select an unknown English word, look it up offline in Chinese, highlight it in context, and review later.

**URL:** https://xuqidong.github.io/text-reader-v2/

## Stack

| Layer | Choice |
|---|---|
| Framework | None — vanilla JavaScript modules |
| Styling | Single CSS file `src/styles.css`, CSS custom properties |
| Storage | IndexedDB (`text-reader`, version 4) |
| Sync | Supabase (manual push/pull only) |
| Dictionary | Built-in 40K ECDICT core plus optional full ECDICT, stored in IndexedDB |
| Hosting | GitHub Pages (static, HTTPS) |
| Service Worker | Versioned app shell, network-first navigation, cache-first static assets |

## Files

```
.
├── index.html              # App shell HTML
├── sw.js                   # Service worker
├── manifest.webmanifest    # PWA manifest
├── server.py               # Local dev server (port 5173)
├── package.json            # dev/check scripts only
├── CLAUDE.md               # This file
├── .gitignore
├── assets/
│   ├── icon.svg            # PWA icon (SVG)
│   ├── icon-192.png
│   ├── icon-512.png
│   └── dictionary-core.json # Built-in offline English-Chinese core
├── scripts/
│   └── build-core-dictionary.mjs
└── src/
    ├── app.js              # UI and reader interactions
    ├── config.js           # Public deploy-time Supabase values
    ├── db.js               # IndexedDB schema and migrations
    ├── dictionary.js       # Offline dictionary install and lookup
    ├── sync.js             # Session and directional Supabase sync
    └── styles.css           # All styles
```

## Local Development

```bash
npm run dev        # Start dev server on http://localhost:5173
npm run check      # Syntax check every JavaScript module and service worker
```

The dev server (`server.py`) adds `Cache-Control: no-cache` on `/sw.js` so the browser always checks for SW updates locally.

## Key Design Decisions

### Reader Rendering

Book text is rendered in chunks as plain text nodes. Only saved highlights get `<mark>` elements. We do **not** wrap every English word in a DOM node — iPad would choke on large books. Tap lookup resolves from the browser caret position instead.

### Highlight Flow

1. User taps/selects English text
2. Dictionary panel opens with lookup result
3. User saves the word (or removes it if already saved)
4. Affected text chunks re-render immediately
5. IndexedDB write queues in the background
6. Highlight list in library updates when user returns to library view

### Performance Constraints

- **iPad is the bottleneck device.** Laptop and Pixel can hide problems that iPad exposes.
- On tablet/mobile, the library pane hides behind a single-pane reader to avoid hidden DOM work.
- Highlight/unhighlight must feel immediate — no waiting for IndexedDB or sync.
- Library highlight list refresh is deferred until returning to the library.

### Sync Model

- **Manual only.** Reading actions never trigger sync.
- **Push:** this device overwrites the cloud (upsert local rows, then delete stale cloud rows).
- **Pull:** the cloud overwrites this device in one local transaction.
- No merge logic. No conflict resolution. Directional overwrite only.

### Dictionary

- English → Chinese only. Chinese → English is intentionally disabled.
- A curated 40,000-word ECDICT core installs automatically and is part of the offline app shell.
- The full ECDICT installer streams data into IndexedDB in batches and resumes after interruption.
- Existing large v39 dictionary installs are adopted instead of discarded.
- Public dictionary data is excluded from user backups because it can be reinstalled; custom dictionary records are backed up and take precedence over ECDICT updates.

### Book Identity

Books are identified by content hash (SHA-256 of normalized text). Same TXT file on different devices gets the same ID.

## Version Management

Two constants must always bump together when app behavior changes:

| Location | Constant | Purpose |
|---|---|---|
| `src/app.js` | `APP_VERSION` | Shown in UI, identifies behavior changes |
| `sw.js:1` | `CACHE_NAME` | Forces SW re-install to pick up new code |

When you change `APP_VERSION` or `CACHE_NAME`, bump both to the same value (e.g., v39 → v40).

### Service Worker Auto-Update

The SW pre-caches a versioned app shell, uses network-first navigation, and bypasses all cross-origin traffic so dictionary downloads and Supabase responses are never duplicated in Cache Storage. It uses `skipWaiting()` + `clients.claim()`; `app.js` reloads once on `controllerchange`.

## Deployment

- **Production:** GitHub Pages from `main` branch, root directory
- **Deploy trigger:** any push to `main`
- **Path handling:** all static asset references use relative paths (`./src/app.js`, `./manifest.webmanifest`) so the app works on both root (`localhost:5173`) and subdirectory (`xuqidong.github.io/text-reader-v2/`) deployments

## Supabase Setup

Run `docs/supabase-schema.sql` from the original project to create the three tables (`tr_books`, `tr_highlights`, `tr_positions`) with row-level security and delete policies.

Add `https://xuqidong.github.io` to Supabase allowed redirect URLs for auth.

Put the public Project URL and publishable/anon key in `src/config.js` before deployment. Never put a service-role or secret key there. Existing per-device v39 configuration is still read as a migration fallback.

## What NOT to Change Without Explicit Approval

- Do not add automatic sync on every highlight/edit action
- Do not add merge/conflict sync logic (push/pull overwrite is the chosen model)
- Do not re-render the full book after each highlight change
- Do not wrap individual words in DOM spans for lookup
- Do not add Chinese-to-English lookup
- Do not add EPUB/PDF support
- Do not add new dependencies unless proven necessary
- Do not trust laptop performance as evidence that iPad will be fine
- Do not refactor broadly while fixing a specific device bug

## Testing Checklist

Before calling a change done:

- [ ] Laptop Chrome: app loads, import works, highlight works, position persists
- [ ] iPad Safari or Chrome: same checks, verify no visible lag
- [ ] Pixel Chrome: same checks
- [ ] Reload preserves local data (books, highlights, position, dictionary)
- [ ] Offline mode: page loads from cache, dictionary works, highlights work
- [ ] Push from device A, pull on device B: books/highlights/positions match
- [ ] Bump APP_VERSION + CACHE_NAME if behavior changed

## Git History

The original project (codex `text_reader`) was built with a different tool. This repo started fresh from the stable baseline. The original lives at `~/codex_projects/text_reader/` for reference — its `docs/` folder and `AGENTS.md` contain additional context on lessons learned.
