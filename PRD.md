# SongNotes — Product Requirements Document

**Version:** 1.0  
**Last updated:** April 2026  
**Author:** Aishwarya Chulaki  
**Status:** In active development — pre-launch

---

## 1. What is SongNotes?

SongNotes is a Chrome extension that lets people attach personal notes to specific moments in Spotify songs and share them with others. When the recipient listens to that song, the notes appear as a pop-up card on their screen at the exact timestamp the sender chose — like finding a handwritten note tucked inside a song.

The core emotional proposition: **music as a love language, made tangible.**

---

## 2. The Problem

People constantly want to share what a song means to them — a lyric, a memory, a feeling at a specific moment — but there's no way to do this inside the listening experience itself. Sending a message separately breaks the magic. SongNotes closes that gap: the note lives inside the song, appearing at exactly the right moment.

---

## 3. Target Users

**Primary:** 16–26 year olds in India who use music as a love language  
**Psychographic:** "this song made me think of you" people — romantic partners, close friends, people who share playlists as emotional communication  
**Secondary:** Global music fanatics — Swifties, K-pop stans, Arijit Singh listeners, indie music lovers  

**Primary market:** India  
**Secondary market:** International (US, UK, Southeast Asia)

---

## 4. Core Features (Built)

### 4.1 Chrome Extension Popup
- **Now Playing card** — detects current Spotify track via content script, shows title + artist with a postmark stamp aesthetic
- **Composer card** — write a note with recipient name, note text (max 260 chars), optional timestamp
- **"Now" button** — captures current playback position as the timestamp
- **Save note** — stores note locally and pushes to Supabase
- **Notes grid** — shows all saved notes for the current song, deletable
- **Share card** — generates a shareable link, accepts a playlist URL, "Send all notes" button
- **Previous Experiences** — list of past shares with thumbnail, reactivate button, "View more" link to account page
- **Import block** — paste a share link to import someone else's notes

### 4.2 Spotify Toast Notification
- A stationery-aesthetic card (`floater.png` background — torn paper, floral) appears in the top-right corner of the Spotify web player
- Shows sender name + note text at the exact timestamp
- Text size adapts to note length: large italic serif (< 60 chars), medium italic (< 140 chars), small sans-serif (260 chars)
- Auto-dismisses after a reading-time-based duration (4–15 seconds)
- Hover pauses the timer; click pins it open; close button dismisses immediately
- Scrub-back detection: re-fires notes if user rewinds past a timestamp

### 4.3 Share Page (`share.html`)
- Hosted on GitHub Pages
- Shows sender name, recipient name, note count, song count
- Note content is **intentionally hidden** (redacted lines) — notes are meant to be discovered while listening, not read upfront
- Song titles and timestamps are visible to tell the recipient what to listen to
- Spotify open button + import into extension button
- If extension not installed: nudge to install

### 4.4 Auth (`auth.html`)
- Google OAuth via Supabase
- Email/password sign in + sign up
- Magic link (passwordless)
- Session stored in `chrome.storage.local`, bridged via `auth-bridge.js`

### 4.5 Account / Credits Page (`account.html`)
- Shows current credit balance as a large display number
- "Your notes left" hero card with flower illustration
- Pricing tiers (see Section 6)
- Lifetime plan
- Purchase history
- Sign out
- Razorpay payment integration (India)

---

## 5. Technical Architecture

| Layer | Technology |
|---|---|
| Extension type | Chrome Manifest V3 |
| Backend / DB | Supabase (Postgres + Auth + REST API) |
| Payments (India) | Razorpay |
| Payments (International) | Stripe (planned) |
| Hosting | GitHub Pages (`aishwaryachulaki.github.io/songnotes`) |
| Auth bridge | Custom event system (`songnotes:auth`, `songnotes:signout`) |
| Share bridge | Custom event system (`songnotes:import`, `songnotes:imported`) |

### Key Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest — declares permissions, content scripts, popup |
| `popup.html` / `popup.css` / `popup.js` | Extension popup UI and all logic |
| `content.js` / `content.css` | Injected into Spotify — detects track, fires toast overlays |
| `auth.html` | Supabase auth page (Google, email, magic link) |
| `auth-bridge.js` | Content script — bridges auth session into extension storage |
| `account.html` | Credits + payment page |
| `share.html` | Public share page for recipients |
| `share-bridge.js` | Content script — bridges share imports into extension storage |
| `config.js` | Supabase URL + key, share origin |
| `floater.png` | Background image for the Spotify toast card |

### Supabase Tables

| Table | Key Columns |
|---|---|
| `user_credits` | `user_id`, `paid_credits`, `lifetime` (bool), `monthly_free_used_at` |
| `purchases` | `user_id`, `credits_added`, `amount_paise`, `is_lifetime`, `razorpay_payment_id`, `created_at` |
| `shares` | `id`, `share_type`, `playlist_id`, `playlist_url`, `sender_name`, `recipient_name` |
| `annotations` | `id`, `share_id`, `track_id`, `track_title`, `track_artist`, `note`, `timestamp`, `sender_name` |

### Local Storage Schema (`chrome.storage.local`)
```
sn_session   → { access_token, refresh_token, expires_at, user: { id, email, name } }
sn_sender    → string (display name)
sn_shares    → {
  active: "<id>",
  shares: {
    [id]: {
      id, mode: "editing"|"inactive",
      type: "single"|"multi"|"playlist",
      playlist_id, playlist_url,
      sender_name, recipient_name,
      notes: [{ id, track_id, track_title, track_artist, note, timestamp, sender_name, created_at }],
      imported: bool, created_at
    }
  },
  previous: ["<id>", ...]
}
```

---

## 6. Monetisation

### Credit Model
- **3 free letters** on sign-up (Figma/Goodnotes-style — use them, then pay)
- Credits are consumed per letter sent
- No subscription — pay per pack or go lifetime

### India Pricing (Razorpay)

| Pack | Price | Per letter |
|---|---|---|
| Small moments | ₹150 | ₹30 |
| A little collection | ₹299 | ₹25 |
| Memory stack | ₹549 | ₹22 |
| **Lifetime** | **₹1,499** | Unlimited forever |

*Note: account.html currently shows ₹999 lifetime — to be updated to ₹1,499 before launch.*

### International Pricing (Stripe — planned)

| Pack | Price |
|---|---|
| 5 letters | $6.99 |
| 12 letters | $13.99 |
| 25 letters | $24.99 |
| Lifetime | $67.99 |

### Payment Processing Fees
- **Razorpay:** 2% + 18% GST on fee = ~2.36% effective. No fixed fee.
- **Stripe:** 2.9% + $0.30 per transaction.

### Production TODO
- Razorpay signature verification must be implemented server-side via Supabase Edge Function before going live (currently client-side only — marked with TODO comment in `account.html`)

---

## 7. Design System

### Palette
```
--blush:     #E36888   (pink — primary accent)
--tangerine: #F08C21   (orange — CTAs, highlights)
--cream:     #FFFBF4   (card backgrounds)
--bg:        #F4D9A6   (page background — matches landing page)
--ink:       #3a2418   (dark brown — body text)
--ink-mid:   #8a5a48   (medium brown — secondary text)
--ink-lt:    #c4977a   (light brown — placeholders, tertiary)
```

### Typography
- **Body / headings:** Lora (Google Fonts) — serif, warm
- **Buttons:** Montserrat (Google Fonts) — clean, modern contrast
- **Toast note text:** Playfair Display italic (injected into Spotify page)

### Aesthetic
Warm stationery — paper textures, ink, postmarks, floral illustrations, ruled lines. Feels like receiving a handwritten letter, not a notification.

### Image Assets
| File | Used in |
|---|---|
| `floater.png` | Spotify toast card background |
| `now-playing-bg.png` | Popup now-playing card background |
| `note-body-bg.png` | Popup composer card background |
| `credits-flower.png` | Account page hero card (right side) |
| `credits-sparkles.png` | Account page pricing tier cards (corner) |
| `lifetime-flower.png` | Account page lifetime card (right side) |
| `prev-thumb.png` | Popup previous experiences thumbnails + account empty state |
| `cardboard-texture.jpg` | Account page background grain overlay |

---

## 8. Growth Strategy

### Built-in Viral Loop
Every note sent brings a new potential user. The recipient visits the share page → sees the product → installs → becomes a sender. K-factor estimated at 0.2–0.3 organically.

### Social Media
- **Instagram** (primary): Reels of the toast appearing mid-song, emotional prompts, UGC
- **Twitter/X** (primary): Launch thread, music discourse engagement
- **Reddit** (secondary): r/InternetIsBeautiful launch post, r/spotify

### Launch Sequence
1. Build Instagram presence 2 weeks before launch (emotional prompts, no product yet)
2. Teaser week: show the floater without explaining it
3. Launch day: Twitter thread + r/InternetIsBeautiful simultaneously
4. Week 2: r/spotify post
5. Week 3: micro-influencer posts go live (music recommendation accounts, 5K–80K followers)

### Future Growth Features
- **Spotify Wrapped-style annual report** — free, shareable, drives December installs
- **Themes / stationery packs** — seasonal limited drops (Holi, Monsoon, Diwali, Winter)
- **Gift credits** — buy credits for someone else

---

## 9. Planned Features (Post-Launch)

| Feature | Priority | Notes |
|---|---|---|
| Themes / stationery packs | High | First theme drop post-launch. ₹99/$4.99 each. Lifetime users get 1 free theme at purchase. |
| Wrapped annual report | High | Free, shareable, December release |
| Scheduled delivery | Medium | Send note at a specific time / occasion |
| Gift credits | Medium | Buy credits for a friend |
| Voice notes | Low | Record short audio note — premium credit cost |
| Reactions / replies | Low | Recipients can reply, doubles credit consumption |

---

## 10. Revenue Projections (Conservative, India-first)

Based on 25% MoM organic growth, 5% install-to-paid conversion, 30% repurchase rate:

| Milestone | Monthly Revenue |
|---|---|
| Month 3 | ~₹12,000 |
| Month 6 | ~₹24,000 |
| Month 9 | ~₹47,000 |
| Month 12 | ~₹93,000 |

Year 1 annualised gross: ~₹5–6 lakh. Doubles if viral coefficient hits 0.4+.

---

## 11. Known Issues / TODOs

- [ ] Razorpay server-side signature verification (Edge Function) before going live
- [ ] Lifetime price in `account.html` needs updating from ₹999 → ₹1,499
- [ ] Stripe integration for international payments (not yet built)
- [ ] Chrome Web Store listing — `EXTENSION_CWS_URL` in `share.html` is currently `null`
- [ ] Extension currently distributed as unpacked (developer mode) — needs CWS submission
- [ ] Local tracks (non-Spotify files) fall back to search — edge case, low priority
