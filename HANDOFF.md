# Keepsake — Handoff

## Goal
Get the Keepsake Chrome extension ready for public launch and Chrome Web Store submission. The extension lets users attach timestamped notes to Spotify songs and share them as an encrypted link. The recipient opens the link, imports it into the extension, and the notes appear as overlays at the exact moments in the song.

---

## Current state of the code

### What's working end-to-end
- **Note writing + saving** — side panel, composer, timestamp capture, storage
- **Sharing** — AES-256-GCM encryption, Razorpay credit check, Supabase push, share link with key in URL fragment
- **Receiving** — share.html decrypts and displays notes; import via extension popup stores locally and now also writes to `received_shares` table in Supabase
- **Overlays** — content.js fires note toasts at the right timestamps on Spotify; no duplicate fires on save
- **Auth** — Google OAuth, email/password, magic link; session synced to extension storage via auth-bridge.js
- **Credits** — free monthly credit, paid bundles via Razorpay, lifetime option; `use_credit` RPC called after successful push
- **notes.html** — Sent and Received tabs, 4-column grid, 16 per page, footer pinned to bottom
- **Side panel** — extension icon opens persistent side panel (v1.4.0); live track polling every 2s updates Now Playing automatically without user reopening

### What's NOT done yet (blocks launch)
1. **Run the received_shares SQL migration** — file is at `migrations/received_shares.sql`, needs to be pasted into Supabase SQL editor and executed once. Until then, the Received tab shows "Coming soon" for every user.
2. **account.html redesign** — a detailed plan exists at `/Users/directory/.claude/plans/splendid-percolating-ritchie.md`. The current page is functional but visually plain. This is the monetisation surface — people see it when buying credits.
3. **First-run / onboarding** — no `chrome.runtime.onInstalled` handler, no welcome screen. New users open the side panel to a blank composer with no guidance. Needs at minimum: open Spotify prompt, name setup explanation.
4. **Razorpay server-side signature verification** — payments work but the signature returned by Razorpay is not verified server-side. Fine for testing, not for real money. Implement as a Supabase Edge Function before going live. (Flagged in memory: `keepsake_payments.md`)
5. **Side panel not tested in Chrome** — built this session but not loaded and verified in a real browser yet.

### Low priority / pre-submission only
- Delete dev files before Chrome Web Store submission: `faq-demo.html`, `PRD.md`, `reference.jpg`, `faq-reference.png`, `ChatGPT Image May 5, 2026, 11_16_27 AM.png`, `.claude/`
- Check `stamp-olive.jpg` vs `stamp-olive.png` — one is a duplicate, delete whichever isn't referenced
- `popup.html` is no longer the entry point (side panel took over) but still exists in the repo — fine to leave until cleanup

---

## Files actively edited this session

| File | What changed |
|---|---|
| `manifest.json` | Added `sidePanel` permission + `side_panel.default_path`, background service worker, removed `default_popup`, bumped to v1.4.0 |
| `background.js` | New file — `setPanelBehavior({ openPanelOnActionClick: true })` |
| `sidepanel.html` | New file — clone of popup.html, overrides `body { width: 100% }` |
| `popup.js` | Retry rollback on note push fail; `looksEncrypted()` helper; `recipient_name` ciphertext guard on import; `received_shares` write on import; `startLiveTracking()` 2s poll |
| `content.js` | Removed state reset from `KS_REFRESH` handler (was causing duplicate toasts) |
| `auth.html` | `!redirecting` guard on signup confirmation message; `keepsake:auth_saved` redirect instead of blind 1s timeout |
| `popup.html` | Postmark year 2025 → 2026 |
| `notes.html` | Received empty state → 4 ghost squares; footer pinned with `margin-top: auto`; `PAGE_SIZE` 10 → 16; loading state → Spectral italic with breathe animation; yellow/pink texture `top` positioning |
| `account.html` | Loading state refinement; yellow/pink texture `top` positioning |
| `sent.html` | `looksEncrypted()` + `safeDisplay()` for recipient_name; loading state; texture fix |
| `received.html` | Loading state; texture fix |
| `share-bridge.js` | Removed dead `ks_share_origin` storage write |
| `migrations/received_shares.sql` | New file — run this in Supabase SQL editor |

---

## Things tried that failed or were ruled out

**Moving annotation to the website (Genius-style web player)**
User floated the idea of annotating on the website instead of the extension to reduce friction. Ruled out because: the Spotify Web Playback SDK requires Premium + OAuth, the Connect API is rate-limited and polling-based, and tab-switching between the website and Spotify would be worse than the popup. The right fix for friction was the side panel — keeps the extension persistent alongside Spotify.

**`sed` with single-space pattern for texture fix**
First pass of `sed` replacing `center / cover` with `top / cover` on the pink texture missed instances that had three spaces between the URL and `center` (e.g., `url('faq-bg-pink.png')   center`). Required a second targeted pass with the exact three-space string.

---

## Next step to take

**Run the Supabase migration first** — it's a one-paste job and unblocks the Received tab for every user. Then tackle the account.html redesign using the existing plan, because that's the monetisation page and it's visually inconsistent with the rest of the product. After that, onboarding.

Order:
1. Run `migrations/received_shares.sql` in Supabase SQL editor
2. `account.html` redesign (plan already written — assets needed: `credits-flower.png`, `credits-sparkles.png`, `lifetime-flower.png`)
3. First-run experience (onboarding flow for new installs)
4. Razorpay server-side signature verification via Edge Function
5. Full end-to-end test of the side panel in Chrome
6. Dev file cleanup → Chrome Web Store submission
