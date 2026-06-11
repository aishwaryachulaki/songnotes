# Keepsake — code review guide

Thanks for taking a look. This is a quick map of the codebase so you can review
efficiently and focus on the parts that matter.

## What it is

Keepsake is a **Chrome/Chromium browser extension + companion website** that lets
people pin timestamped, **end-to-end-encrypted** notes to moments in a Spotify
song and share them as a link. When the recipient plays the song, the notes pop
up on screen at the exact second they were pinned.

- **Website:** static, hosted on GitHub Pages at `https://dropakeepsake.com`
- **Backend:** Supabase (Postgres + RLS + Edge Functions + Auth)
- **Payments:** Razorpay (India-first), server-authoritative

## Architecture at a glance

```
Spotify web player ──(content.js fires note pop-ups)──┐
                                                       │
Browser extension (side panel)                         │  chrome.storage.local
  sidepanel.html + popup.js  ── writes/encrypts notes ─┤  (per-account, ks_* keys)
                                                       │
  bridges (content scripts on dropakeepsake.com):      │
   auth-bridge.js   website⇄extension session + logout │
   share-bridge.js  share page → import a keepsake     │
   notes-bridge.js  notes page → relive / onboarding   │
                                                       ▼
Website (dropakeepsake.com, static)        Supabase
  index/auth/account/notes/share/welcome     Postgres tables + RLS
                                             Edge Functions (Deno)
                                             Auth (Google OAuth)
```

## Key files

**Extension**
- `manifest.json` — MV3 manifest (permissions, content-script match patterns, icons)
- `background.js` — service worker: opens side panel, first-run install (tutorial + welcome tab), caches the current Spotify track
- `content.js` / `content.css` — runs on `open.spotify.com`; the `tick()` loop fires note + tutorial pop-ups by timestamp
- `sidepanel.html` + `popup.js` + `popup.css` — the side-panel UI (write, share, relive, vault, tutorial). `popup.js` is the bulk of the client logic
- `config.js` — public anon Supabase config (intentionally public)
- `auth-bridge.js` / `share-bridge.js` / `notes-bridge.js` — content scripts that bridge the website pages to extension storage

**Website (static)**
- `index.html` (marketing), `auth.html` (Google login), `account.html` (credits + Razorpay checkout), `notes.html` (Sent/Received tabs), `share.html` (recipient's keepsake card), `welcome.html` (onboarding), `faq.html`, legal pages (`privacy/terms/eula/cookie-policy/refund`)

**Backend**
- `supabase/functions/*` — `create-razorpay-order`, `verify-razorpay-payment`, `razorpay-webhook`
- `migrations/*.sql` — table + RLS definitions (`create_share`, `payment_orders`, `received_shares`, `vault`, `delete_user_account`). Note: a few RPCs/triggers (`get_share`, `use_credit`, `add_credits`, `handle_new_user`) were authored directly in the Supabase SQL editor and aren't all in the repo.

## The flows worth tracing

1. **Write → share:** `popup.js` `copyShare()` → encrypts note/description/names client-side (`encryptField`) → `supabaseRpc("create_share", …)` (atomic: consume a credit + insert share + annotations in one SECURITY DEFINER function) → returns a link with the AES key in the URL `#fragment`.
2. **Receive:** `share.html` fetches the share by id via the `get_share` RPC, decrypts with the key from the fragment, renders the card. `share-bridge.js` imports it into the extension (+ records it in `received_shares` if signed in).
3. **Relive:** `notes-bridge.js` activates a sent/received keepsake so `content.js` fires its notes again on Spotify.
4. **Payments:** `account.html` → `create-razorpay-order` (JWT-auth, server-decided amount, records `payment_orders`) → Razorpay checkout → `verify-razorpay-payment` (HMAC verify + atomic `created→fulfilled` claim + `add_credits`). `razorpay-webhook` is a server-to-server backstop.
5. **Auth sync:** every authed website page re-pushes the session to the extension until `auth-bridge.js` confirms; logout in the extension propagates back to clear the website session.

## Security model (the heart of it)

- **End-to-end encryption:** AES-256-GCM (Web Crypto). The per-keepsake key lives **only in the share-link URL fragment**, never sent to the server. The server stores ciphertext for note text, description, and names. See `encryptField`/`decryptField` in `popup.js` and `share.html`.
- **RLS:** every table is owner-scoped (`auth.uid() = user_id`); recipients get additive read policies for keepsakes they've imported (via `received_shares`) — and even then only see ciphertext + public song metadata.
- **Server-authoritative payments:** the price/credits catalog (`PACKAGES`) lives in the edge functions; the client only sends a `package_id`. Grants go through an atomic `created→fulfilled` order claim, so they're replay/double-grant proof. `add_credits` is `service_role`-only.
- **Cross-device "Relive" vault:** zero-knowledge. A passphrase → PBKDF2 master key (never leaves the device) wraps each per-keepsake key in `vault_keys`. Even we can't read them.

## Intentional / not bugs

- The **Supabase anon key** (`config.js`) and **Razorpay Key ID** (`account.html`, `share.html`) are **public by design**. The real secrets live only in Supabase env vars.
- `PACKAGES` is duplicated in 3 edge functions + `account.html` — kept in sync manually (noted in comments).

## Not done yet (don't flag these)

- **International payments**: `openStripe()` in `account.html` is a stub ("coming soon"); launch is India-only via Razorpay.
- **`EXTENSION_CWS_URL`** in `share.html` is a placeholder until the extension is published to the Web Store.
- **Security headers**: GitHub Pages can't set HTTP headers, so we use a CSP `<meta>` tag + a JS frame-buster instead of real `X-Frame-Options`/CSP headers (Cloudflare in front is planned).
- **Vault passphrase recovery** (forgot-passphrase) is not built yet.

## Where I'd most value your eyes

1. The three **Razorpay edge functions** (auth, HMAC, the atomic claim) — money path.
2. **`create_share`** + the RLS policies — can a client create a share without spending a credit, or read data they shouldn't?
3. The **auth bridges** (session sync + global logout) — any way to desync or hijack?
4. The **encryption** usage in `popup.js` / `share.html` — IV handling, key derivation, anything that could leak plaintext.

## Running it locally

- **Extension:** `chrome://extensions` → Developer mode → "Load unpacked" → select this folder (Chrome reads `manifest.json`; the website files alongside are ignored). The content scripts target the live `dropakeepsake.com`, so the website pieces run against production.
- **Website:** it's static; `python3 -m http.server` serves it, but the extension bridges only run on `dropakeepsake.com` (per the manifest match patterns).
