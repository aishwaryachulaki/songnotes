// Open the side panel when the user clicks the extension icon.
// setPanelBehavior persists across sessions so this only needs to run once,
// but calling it on every service-worker startup is harmless.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// ── Tutorial / onboarding ──────────────────────────────────────────────────
// Tutorial notes fire every 7 seconds on ANY currently-playing track.
// track_id is null so content.js skips the track-id check entirely.
// IMPORTANT: keep this copy + TUTORIAL_VERSION in sync with popup.js
// (buildTutorialShare). popup.js self-heals stale installs on version bump.
const TUTORIAL_TOTAL = 10;
const TUTORIAL_VERSION = 3;
function mkNote(id, step, ts, text) {
  return { id, track_id:null, timestamp:ts, is_tutorial:true,
           tutorial_step: step, tutorial_total: TUTORIAL_TOTAL,
           tutorial_version: TUTORIAL_VERSION, sender_name:"Keepsake",
           created_at: Date.now(), note: text };
}

function makeTutorialShare() {
  return {
    id: "ks-tutorial",
    mode: "editing",
    type: "single",
    playlist_id: null, playlist_url: null, playlist_name: null,
    sender_name: "Keepsake",
    recipient_name: null, description: null,
    is_tutorial: true, tutorial_version: TUTORIAL_VERSION,
    imported: false, created_at: Date.now(),
    notes: [
      mkNote("t01", 1,  0,  "Welcome to Keepsake. These little notes will show you the way. Open the side panel to follow along: tap the Keepsake icon up in your toolbar."),
      mkNote("t02", 2,  7,  "Start with your name. It's the signature on everything you send, so whoever opens this knows it came from you."),
      mkNote("t03", 3,  14, "Who is this one for? Add their name in the panel. A parent, a partner, a fan, someone you adore. Anyone at all."),
      mkNote("t04", 4,  21, "Now the good part: write your note. Whatever this moment in the song stirs in you, say it here."),
      mkNote("t05", 5,  28, "Pin it to the second. Tap Now to catch the current time, or type the timestamp in yourself if a moment is calling you."),
      mkNote("t06", 6,  35, "Hit Save and it's sealed. Add as many notes as you like, across as many songs. Each one waits quietly for its cue."),
      mkNote("t07", 7,  42, "Scroll to the share panel and leave a little description. It's the first thing they read, before a single note plays."),
      mkNote("t08", 8,  49, "Ready? Hit SHARE for your link. Wrote across a few songs? You'll drop in the playlist link first."),
      mkNote("t09", 9,  56, "Now send it off, to anyone, anywhere. It opens as a quiet little card holding every note you left."),
      mkNote("t10", 10, 63, "And if they add Keepsake, your notes come alive as they listen. That's everything. Go make someone's day. ✦"),
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
