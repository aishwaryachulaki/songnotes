// Open the side panel when the user clicks the extension icon.
// setPanelBehavior persists across sessions so this only needs to run once,
// but calling it on every service-worker startup is harmless.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// ── Tutorial / onboarding ──────────────────────────────────────────────────
// Tutorial notes fire every 7 seconds on ANY currently-playing track.
// track_id is null so content.js skips the track-id check entirely.
// tutorial_total is stored on each note so the badge can show "STEP N OF 10".
const TUTORIAL_TOTAL = 10;
function mkNote(id, step, ts, text) {
  return { id, track_id:null, timestamp:ts, is_tutorial:true,
           tutorial_total: TUTORIAL_TOTAL, sender_name:"Keepsake",
           created_at: Date.now(), note: `Step ${step}: ${text}` };
}

function makeTutorialShare() {
  return {
    id: "ks-tutorial",
    mode: "editing",
    type: "single",
    playlist_id: null, playlist_url: null, playlist_name: null,
    sender_name: "Keepsake",
    recipient_name: null, description: null,
    is_tutorial: true, imported: false, created_at: Date.now(),
    notes: [
      mkNote("t01", 1,  0,  "Welcome to Keepsake! Play any song on Spotify and the side panel will guide you. Click the Keepsake icon in Chrome's toolbar to open it now."),
      mkNote("t02", 2,  7,  "Enter your name in the panel — friends see this when they receive your keepsake. You only need to set it once."),
      mkNote("t03", 3,  14, "Write a note in the text box. Say something meaningful about this exact moment in the song — a memory, a feeling, anything."),
      mkNote("t04", 4,  21, "Hit the Now button to stamp the current second, then Save. Your note is now pinned to this moment. It will pop up for anyone who listens here."),
      mkNote("t05", 5,  28, "You can add notes across as many songs as you want. Each note fires at its own pinned second when your friend listens."),
      mkNote("t06", 6,  35, "Scroll down to the SHARE WITH panel. Add your friend's name in the recipient box so the keepsake feels personal."),
      mkNote("t07", 7,  42, "See the description box? Write what this keepsake is about. It shows on the share page your friend sees before they listen."),
      mkNote("t08", 8,  49, "Hit SHARE to generate your link. If you have notes on multiple songs, you'll be asked to add the Spotify playlist link first."),
      mkNote("t09", 9,  56, "Send the link to your friend. They see a beautiful card with your notes — no app needed to view it."),
      mkNote("t10", 10, 63, "If they install Keepsake and import the link, your notes pop up live as they listen. That's it — go make someone's day ✦"),
    ],
  };
}

function createDemoShare(force = false) {
  chrome.storage.local.get(["ks_onboarding", "ks_shares"], (data) => {
    const onboarding = data.ks_onboarding || {};
    if (!force && onboarding.started) return; // already set up

    const store = data.ks_shares || { active: null, shares: {}, previous: [] };

    // Preserve any existing real active share in previous
    if (store.active && store.active !== "ks-tutorial" && store.shares[store.active]) {
      store.previous = [store.active, ...(store.previous || []).filter(x => x !== store.active)];
    }

    store.shares["ks-tutorial"] = makeTutorialShare();
    store.active = "ks-tutorial";

    chrome.storage.local.set({
      ks_shares: store,
      ks_onboarding: { started: true, seen: false },
    });
  });
}

// Fire on fresh install
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") createDemoShare();
});

// Cache the most recent track state broadcast by content.js.
// The side panel may open after the song started, so KS_TRACK_CHANGED was
// already fired before anyone was listening. init() can pull the cached state
// from here instead of fighting with unreliable tab queries.
let cachedTrack = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "KS_TRACK_CHANGED") {
    cachedTrack = { trackId: msg.trackId, title: msg.title, artist: msg.artist };
  }
  if (msg && msg.type === "KS_GET_CACHED_TRACK") {
    sendResponse(cachedTrack);
    return true;
  }
  if (msg && msg.type === "KS_START_TUTORIAL") {
    createDemoShare(/* force= */true);
    sendResponse({ ok: true });
    return true;
  }
});
