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
- **Song detection** — `document.title` is the PRIMARY source (updates immediately on every song change); DOM href cross-validated against title to prevent React staleness bugs; push-based `KS_TRACK_CHANGED` message from content.js to side panel on every track change
- **Side panel** — extension icon opens persistent side panel; listens for `KS_TRACK_CHANGED` push messages rather than polling; `init()` and `startLiveTracking()` run independently (one failing doesn't block the other)
- **Website** — all non-index pages (account, sent, received, faq, privacy, notes, auth) are contained to 560px max-width centered layout; consistent Spectral italic rose logo across all pages
- **sent.html** — looksEncrypted() catches purely alphanumeric ciphertext (no + / = required); playlist/multi shares show a song+note count summary instead of first track name; archive/unarchive tab support

### What's NOT done yet (blocks launch)
1. **First-run / onboarding** — no `chrome.runtime.onInstalled` handler, no welcome screen. New users open the side panel to a blank composer with no guidance. Needs at minimum: open Spotify prompt, name setup explanation.
2. **Razorpay server-side signature verification** — payments work but the Razorpay signature is not verified server-side. Fine for testing, not for real money. Implement as a Supabase Edge Function before going live. (Flagged in memory: `keepsake_payments.md`)
3. **account.html hero assets** — `credits-flower.png` and `credits-sparkles.png` for the credits hero card are still pending.

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

### Song detection (content.js)
- `getTrackInfo()` uses `document.title` as PRIMARY (format: `"Song • Artist"` or `"Spotify – Song · Artist"`)
- DOM `<a href="/track/...">` links are cross-validated: only trusted if link text matches title (prevents React href-lag bug)
- On track change, content.js sends `chrome.runtime.sendMessage({ type: "KS_TRACK_CHANGED", trackId, title, artist })`
- Side panel registers `chrome.runtime.onMessage` listener for `KS_TRACK_CHANGED` in `startLiveTracking()`
- Removed `document.hidden` guard from poll loop — Chrome marks side panel as hidden when Spotify tab has focus, which was suppressing all polls

### Share types
- `share.type` / `share_type` in Supabase: `"single"` | `"multi"` | `"playlist"`
- `deriveType(share)`: returns "playlist" if `playlist_id || playlist_url`, "multi" if >1 unique track_id, else "single"
- sent.html `renderCard()` shows first track title only for "single" shares; playlist/multi shows "N songs, M notes" summary

### Encryption
- AES-256-GCM via Web Crypto API; key lives only in the URL fragment (`#k=...`), never server-side
- `looksEncrypted(s)`: `s.length > 30 && !/\s/.test(s) && /^[A-Za-z0-9+\/=]+$/.test(s)` — catches both padded and unpadded base64 ciphertext

---

## Files edited across recent sessions

| File | What changed |
|---|---|
| `manifest.json` | `sidePanel` permission, `side_panel.default_path`, background service worker, v1.4.0 |
| `background.js` | `setPanelBehavior({ openPanelOnActionClick: true })` |
| `content.js` | `document.title` primary source; DOM href cross-validation; `KS_TRACK_CHANGED` push on track change; removed `document.hidden` guard |
| `popup.js` | `freeCreditsRemaining()` (3 lifetime free, not monthly); credits badge refresh after save; `startLiveTracking()` with push-based `KS_TRACK_CHANGED` listener; `init()` and `startLiveTracking()` independent; song change detection uses title+trackId comparison |
| `account.html` | Full pricing redesign: 560px contained layout, 2×2 bundle grid + lifetime card, neutral texture backgrounds, soft typography |
| `sent.html` | `looksEncrypted()` — no `+/=` requirement; `renderCard()` — playlist/multi show song+note count; 560px contained layout |
| `received.html` | 560px contained layout |
| `notes.html` | 560px contained layout, 2-column grid |
| `faq.html` | 560px contained layout; nav max-width 560px; floral illustration removed |
| `index.html` | Floral illustration removed |
| `privacy.html` | Spectral italic logo; 560px contained layout |
| `auth.html` | Logo color `var(--rose)` |

---

## Known remaining bugs / issues
- **Song detection while panel is open** — push architecture is in place but there may still be edge cases where the panel misses a track change if it was already open when the song changed. If this recurs: the `KS_GET_STATE` poll path (triggered by `startLiveTracking`) is the fallback; check that `chrome.tabs.sendMessage` is reaching the correct Spotify tab.
- **Received tab recipient decryption** — imported shares decrypt in the extension fine, but the website `received.html` shows whatever is in `received_shares.sender_name` (stored encrypted). Not a bug per se — decryption only happens inside the extension.

---

## Next steps (in order)

1. **First-run onboarding** — `chrome.runtime.onInstalled` handler; welcome screen or at minimum a "go to open.spotify.com" prompt on first open
2. **Razorpay server-side verification** — Supabase Edge Function to verify `razorpay_signature` before crediting account (see `keepsake_payments.md` in memory)
3. **account.html hero assets** — drop in `credits-flower.png` and `credits-sparkles.png`
4. **Full end-to-end test** — fresh Chrome profile, install extension, send a note, receive it, buy a credit pack, check every flow
5. **Dev file cleanup** — `faq-demo.html`, `PRD.md`, `reference.jpg`, `faq-reference.png`, `ChatGPT Image May 5, 2026, 11_16_27 AM.png`
6. **Chrome Web Store submission**
