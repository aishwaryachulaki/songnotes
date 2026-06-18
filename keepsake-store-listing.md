# Keepsake — Chrome Web Store listing

(Internal reference. Lives on the Desktop, OUTSIDE the songnotes repo, so it is
never committed or served on dropakeepsake.com.)

---

## 1. Name
Keepsake

(The store uses manifest.json "name". Keep "Keepsake", or change the manifest
name to something more searchable like "Keepsake: notes for your songs", max 45 chars.)

## 2. Summary (short description, max 132 chars)
Turn Spotify songs or playlists into personal keepsakes with synced notes that appear at the perfect moment.

## 3. Detailed description
Some songs hold a whole memory. Keepsake lets you pin a note to the exact moment a song moves you, then send it to someone you love. When they press play, your words appear on screen in perfect sync, like a handwritten letter tucked inside the music.

How it works:
1. Open the side panel and play any song on the Spotify web player.
2. Write a note and pin it to the exact second, or type a timestamp yourself.
3. Add as many notes as you like, across as many songs as you like.
4. Hit Share to get a link, then send it to anyone.

When they open the link, they see a beautiful keepsake card. Once they add the free extension, your notes come alive at the right moments as the song plays. They can relive it anytime.

Private by design:
Your notes are end-to-end encrypted on your own device before they ever reach our servers. The key lives only in your share link, so we can never read your words. Neither can anyone without the link.

A few more touches:
- A short description on the front of each keepsake, the first thing your person reads.
- Cross-device Relive: turn it on with a private passphrase and your keepsakes follow you to any device you sign into.
- 3 free keepsakes to start. Simple one-time credit packs after that, or go Lifetime for unlimited.

Keepsake works on the Spotify web player in Chrome and most Chromium-based browsers. It is an independent product and is not affiliated with, endorsed by or sponsored by Spotify.

## 4. Category
Communication

(Best fit: Keepsake sends a personal note to one specific person, like a letter.
"Social"/"Social Networking" implies feeds and networks, which this isn't.
Alternatives if you want the music/delight angle: Entertainment or Lifestyle.)

## 5. Single purpose (required field)
Keepsake lets you attach personal notes to specific timestamps in a song on the Spotify web player and share them as a link that plays those notes back in sync.

## 6. Permission justifications (one per permission)
- storage: Saves the user's draft notes, their display name, and their login session locally so the side panel keeps working across page loads.
- activeTab + tabs: Detects the currently playing Spotify track, and opens the side panel and our sign-in/account pages in response to user clicks.
- sidePanel: The entire writing and sharing interface lives in the browser side panel.
- host permission https://open.spotify.com/* : Reads the current track and displays note pop-ups on the Spotify web player.
- host permission https://dropakeepsake.com/* : Syncs the user's login session between our website and the extension, and imports or relives keepsakes the user opens from a share link.

## 7. Privacy
- Privacy policy URL: https://dropakeepsake.com/privacy.html
- Data-practices form — declare and certify:
  - Collects Authentication information (login/session) and User-generated content (the notes).
  - Does NOT sell or transfer data to third parties.
  - Does NOT use data for purposes unrelated to the core function.
  - Does NOT use data for creditworthiness/lending.
  - Note content is end-to-end encrypted.

## 8. Other fields
- Homepage / support URL: https://dropakeepsake.com
- Support email: hello@dropakeepsake.com
- Language: English

## 9. Images you still need to provide
- Screenshots: at least 1 (ideally 3-5) at 1280x800 or 640x400. Check the
  screenshots/ folder for correct dimensions; the store is strict.
- Small promo tile: 440x280 (optional but recommended).

## 10. Post-approval to-do
- Update EXTENSION_CWS_URL in share.html from the "index.html" placeholder to the
  real Chrome Web Store listing URL, then redeploy the site.
