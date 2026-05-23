# Keepsake — Handoff

## Goal
Get the Keepsake Chrome extension ready for public launch and Chrome Web Store submission. The extension lets users attach timestamped notes to Spotify songs and share them as an encrypted link. The recipient opens the link, imports it into the extension, and the notes appear as overlays at the exact moments in the song.

---

## Current state of the code

### What's working end-to-end
- **Note writing + saving** — side panel, composer, timestamp capture, storage
- **Sharing** — AES-256-GCM encryption, Razorpay credit check, Supabase push, share link with key in URL fragment
- **Receiving** — share.html decrypts and displays notes; import via extension popup stores locally and writes to `received_shares` table in Supabase
- **Overlays** — content.js fires note toasts at the right timestamps on Spotify; no duplicate fires per play-through
- **Auth** — Google OAuth, email/password, magic link; session synced to extension storage via auth-bridge.js
- **Credits** — 3 lifetime free credits (`free_credits_used` column), paid bundles via Razorpay, lifetime option; `use_credit` RPC called after successful push; credits badge updates immediately after save without needing to reopen
- **Song detection** — `document.title` is the PRIMARY source (updates immediately on every song change); DOM href cross-validated against title to prevent React staleness bugs; push-based `KS_TRACK_CHANGED` message from content.js to side panel on every track change; background.js caches last known track so side panel can detect already-playing songs on open via `KS_GET_CACHED_TRACK`
- **Side panel** — extension icon opens persistent side panel; listens for `KS_TRACK_CHANGED` push messages rather than polling; `init()` and `startLiveTracking()` run independently (one failing doesn't block the other)
- **Website** — all non-index pages (account, sent, received, faq, privacy, notes, auth) are contained to 560px max-width centered layout; consistent Spectral italic rose (#c0544e) logo across all pages
- **sent.html** — looksEncrypted() catches purely alphanumeric ciphertext (no + / = required); playlist/multi shares show a song+note count summary instead of first track name; archive/unarchive tab support
- **share.html** — fully redesigned: single-screen, non-scrollable hero; "You've received" eyebrow + large Lora title + blush artist line + ✦ divider + note count + recipient; pale pink pill buttons (Import first, then Open in Spotify); share-envelope.png anchored at bottom of hero (half-cropped); "New to Keepsake?" discovery link to index.html; all spacings use clamp() + vh so it scales with browser resize
- **share panel (extension)** — three-state design: single track (auto-fetches album thumbnail via oEmbed), needsPlaylist (shows input + Attach button), playlist (shows thumbnail card); copy-link button after sharing; pale pink pill buttons consistent with site style
- **index.html** — responsive hero: single-column at ≤1100px (illustration hides, envelope centres); `object-position: top center` prevents card clipping; heading uses `clamp()` to prevent text overflow at narrow widths

### What's NOT done yet (blocks launch)
1. **First-run / onboarding** — no `chrome.runtime.onInstalled` handler, no welcome screen. New users open the side panel to a blank composer with no guidance. Needs at minimum: open Spotify prompt, name setup explanation.
2. **Razorpay server-side signature verification** — payments work but the Razorpay signature is not verified server-side. Fine for testing, not for real money. Implement as a Supabase Edge Function before going live. (Flagged in memory: `keepsake_payments.md`)
3. **account.html hero assets** — `credits-flower.png` and `credits-sparkles.png` for the credits hero card are still pending.
4. **Playlist share title on sent.html** — playlist shares still show the first song title instead of "A Playlist Share". Root cause: `share_type`, `playlist_url`, `playlist_id`, and `playlist_name` are all null in Supabase for these shares. `playlist_name` column exists (added via SQL) and the push includes it, but it arrives as null — likely because `playlist_url`/`playlist_id` columns don't exist in the DB so PostgREST silently drops them, causing the oEmbed name fetch to never store. The `uniqueTracks > 1` fallback in `renderCard` is in place but not helping. Needs fresh debugging — check the Supabase `shares` table schema and verify what actually gets stored on a new share push.

### Low priority / pre-submission only
- Delete dev files before Chrome Web Store submission: `faq-demo.html`, `PRD.md`, `reference.jpg`, `faq-reference.png`, `ChatGPT Image May 5, 2026, 11_16_27 AM.png`
- Check `stamp-olive.jpg` vs `stamp-olive.png` — one is a duplicate, delete whichever isn't referenced
- `popup.html` is no longer the entry point (side panel took over) but still exists — fine to leave until cleanup

---

## Architecture notes

### Credits system
- **Supabase table**: `user_credits` with columns `paid_credits`, `lifetime` (bool), `free_credits_used` (int)
- **Free credits**: 3 lifetime (not monthly). `freeCreditsRemaining(c) = Math.max(0, 3 - (c.free_credits_used || 0))`
- **RPC**: `use_credit(p_user_id uuid)` — increments `free_credits_used` if paid_credits=0, else decrements `paid_credits`; returns `{ ok: true }` on success
- If you ever need to recreate the RPC: `DROP FUNCTION IF EXISTS use_credit(uuid)` first (Supabase errors on return-type change without drop)
- Default credits object when DB row is missing: `{ paid_credits: 0, lifetime: false, free_credits_used: 0 }`

### Song detection (content.js + background.js)
- `getTrackInfo()` uses `document.title` as PRIMARY (format: `"Song • Artist"` or `"Spotify – Song · Artist"`)
- DOM `<a href="/track/...">` links are cross-validated: only trusted if link text matches title (prevents React href-lag bug)
- On track change, content.js sends `chrome.runtime.sendMessage({ type: "KS_TRACK_CHANGED", trackId, title, artist })`
- background.js caches the last `KS_TRACK_CHANGED` payload in `cachedTrack`; side panel requests it via `KS_GET_CACHED_TRACK` on open so songs already playing are detected immediately
- Side panel registers `chrome.runtime.onMessage` listener for `KS_TRACK_CHANGED` in `startLiveTracking()`
- Removed `document.hidden` guard from poll loop — Chrome marks side panel as hidden when Spotify tab has focus, which was suppressing all polls
- `getActiveTab()` uses `lastFocusedWindow: true` (not `currentWindow: true`) — side panel has its own window context

### Share types
- `share.type` / `share_type` in Supabase: `"single"` | `"multi"` | `"playlist"`
- `deriveType(share)`: returns "playlist" if `playlist_id || playlist_url`, "multi" if >1 unique track_id, else "single"
- sent.html `renderCard()` shows first track title only for "single" shares; playlist/multi shows "N songs, M notes" summary

### Encryption
- AES-256-GCM via Web Crypto API; key lives only in the URL fragment (`#k=...`), never server-side
- `looksEncrypted(s)`: `s.length > 30 && !/\s/.test(s) && /^[A-Za-z0-9+\/=]+$/.test(s)` — catches both padded and unpadded base64 ciphertext
- `recipient_name` is stored **plaintext** in Supabase (not encrypted) — share.html guards with `looksEncrypted()` before attempting decryption for backwards compatibility with old shares

### share.html design
- Single-screen, `overflow: hidden`, no scroll
- Hero is `height: 100vh` flex column: nav → hero-content (flex:1, centered) → hero-envelope (half-cropped at bottom)
- All spacings use `clamp(min, Xvh/Xvw, max)` for fluid scaling
- Envelope: `width: min(720px, 88vw)`, container `height: clamp(160px, 35vh, 400px)` with `overflow: hidden`
- Buttons: `rgba(227,104,136,0.07)` bg, `rgba(227,104,136,0.40)` border, blush text; hover deepens to `rgba(227,104,136,0.18)` — matches `.prev-activate` in popup.css exactly
- Import button injected dynamically after extension detection (1s timeout); if extension not installed and CWS URL is set, shows "Get Keepsake" install link instead

---

## Files edited across recent sessions

| File | What changed |
|---|---|
| `manifest.json` | `sidePanel` permission, `side_panel.default_path`, background service worker, v1.4.0 |
| `background.js` | `setPanelBehavior`; track state cache (`cachedTrack`, `KS_GET_CACHED_TRACK` handler) |
| `content.js` | `document.title` primary source; DOM href cross-validation; `KS_TRACK_CHANGED` push; removed `document.hidden` guard |
| `popup.js` | `freeCreditsRemaining()` (3 lifetime free); credits badge refresh; `startLiveTracking()` push-based; `getActiveTab()` uses `lastFocusedWindow`; three-state `renderSharePanel()`; oEmbed thumbnail fetch; copy-link button; `attachPlaylist()` handler; `recipient_name` stored plaintext; status pills use `●` dot instead of `✓` |
| `sidepanel.html` | Replaced share card with three-state share panel (sp-* structure); ♪ → ✧ in NOW PLAYING eyebrow; share footer redesigned: paper plane SVG icon on START SHARING button, removed "How sharing works" link, + NEW SHARE text link |
| `popup.html` | ♪ → ✧ in NOW PLAYING eyebrow; + NEW SHARE text updated |
| `popup.css` | Full visual polish pass — see Design system notes below |
| `background-extension.png` | Replaced with less-yellow version |
| `account.html` | Full pricing redesign: 560px contained, 2×2 bundle grid + lifetime card |
| `sent.html` | `looksEncrypted()` fix; `renderCard()` playlist/multi summary; 560px layout |
| `received.html` | 560px contained layout |
| `notes.html` | 560px contained layout, 2-column grid |
| `faq.html` | 560px contained layout; nav max-width 560px; floral illustration removed |
| `index.html` | Floral illustration removed; responsive hero (clamp heading, `object-position: top center`, single-col breakpoint 1100px, block repositioning in media query) |
| `privacy.html` | Spectral italic logo; 560px contained layout |
| `auth.html` | Logo color `var(--rose)` |
| `share.html` | Full redesign: single-screen hero, envelope illustration, blush pill buttons, clamp() responsive spacings, discovery link, hollow ✧ sparkle in buttons |
| `share-envelope.png` | New illustration asset (replaced twice) |

---

## Design system notes (popup.css)

### Depth & shadow hierarchy
- All primary cards (`.stamp-track`, `.composer-card`, `.share-card`, `.share-panel`) use a 3-level warm shadow: `0 2px 4px / 0 6px 18px / 0 12px 32px` all in `rgba(58,36,24,…)`
- Note cards and prev-items use a lighter 2-level shadow
- All card textures set to `background-size: 100% 100%` to prevent pale-edge peek-through
- `body::before` atmospheric vignette at `rgba(255,251,244,0.10)` — very subtle, do not increase or it washes everything out
- `.composer-card::before` top-light overlay at `rgba(255,255,255,0.08)` — same caveat

### Button system
- **All buttons** use the same translucent blush pill: `background: rgba(227,104,136,0.07)`, `border: 1.5px solid rgba(227,104,136,0.40)`, `border-radius: 50px`, `color: var(--blush)`
- Hover deepens to `rgba(227,104,136,0.18)` bg / `rgba(227,104,136,0.65)` border — no colour change, no solid fill
- Vertical padding: `8px` on all main buttons
- **Exception**: `.sp-share-btn` (START SHARING) follows the same blush pill style but is `width: 100%` and includes a paper plane SVG icon
- **Exception**: `.new-share-btn` is a plain text link (no border/background), uppercase, blush, with opacity fade
- **Exception**: `.sp-pill--ready` (READY TO SHARE status badge) uses pastel sage: `rgba(168,204,148,0.22)` bg, `rgba(145,185,120,0.45)` border, `rgba(68,105,48,0.88)` text

### Typography / ink-density system
Five tiers of `rgba(58,36,24,…)` so text reads as ink pressed into paper:
- `--ink` `#3a2418` — Tier 0, song title only
- `--ink-2` `rgba(…0.82)` — body text, input typed values, card titles
- `--ink-3` `rgba(…0.62)` — labels, eyebrows, nav links, artist name, metadata
- `--ink-4` `rgba(…0.44)` — helper text, sub-labels, hint copy
- `--ink-5` `rgba(…0.28)` — placeholders, postmark detail, ghost elements

Key type decisions:
- All `--tangerine` accent text replaced with `--blush`
- Track artist uses `font-style: italic` (Lora italic)
- Status/save confirmation text uses Spectral italic
- `.sp-hint-sub` and import status use italic
- Nav links and composer header weight reduced to 500
- Postmark detail retreated to `--ink-5` (decorative, not informational)
- All hardcoded `#5c2d2d` / `rgba(92,45,45,…)` replaced with ink-tier tokens

### Now Playing card specifics
- Postmark: `top: 50%; transform: translateY(-50%)` for true vertical centring; border `rgba(58,36,24,0.45)`; text at `--ink-3`
- Track title: `-webkit-line-clamp: 2` with ellipsis; `padding-right: 72px` to clear postmark
- Track artist: wraps freely (no `white-space: nowrap`) so error messages display in full
- NOW PLAYING eyebrow: `✧` symbol, `--blush` colour

---

## Known remaining bugs / issues
- **Song detection while panel is open** — push architecture is in place but there may still be edge cases where the panel misses a track change if it was already open when the song changed. Fallback: `KS_GET_STATE` poll path in `startLiveTracking()`; check `chrome.tabs.sendMessage` is reaching the correct Spotify tab.
- **Received tab recipient decryption** — `received.html` shows whatever is in `received_shares.sender_name` (stored encrypted). Not a bug per se — decryption only happens inside the extension.
- **index.html single-column envelope** — content blocks repositioned in media query but may still need fine-tuning at specific viewport sizes. All positions are `%` of `.env-wrap` height — adjust `top`/`left` values in the `@media (max-width: 1100px)` block.

---

## Next steps (in order)

1. **First-run onboarding** — `chrome.runtime.onInstalled` handler; welcome screen or at minimum a "go to open.spotify.com" prompt on first open
2. **Razorpay server-side verification** — Supabase Edge Function to verify `razorpay_signature` before crediting account (see `keepsake_payments.md` in memory)
3. **account.html hero assets** — drop in `credits-flower.png` and `credits-sparkles.png`
4. **Full end-to-end test** — fresh Chrome profile, install extension, send a note, receive it, buy a credit pack, check every flow
5. **Dev file cleanup** — `faq-demo.html`, `PRD.md`, `reference.jpg`, `faq-reference.png`, `ChatGPT Image May 5, 2026, 11_16_27 AM.png`
6. **Chrome Web Store submission**
