// Open the side panel when the user clicks the extension icon.
// setPanelBehavior persists across sessions so this only needs to run once,
// but calling it on every service-worker startup is harmless.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// ── Tutorial / onboarding ──────────────────────────────────────────────────
const TUTORIAL_PLAYLIST_ID  = "5gWV5f3x7IQQRspEkgla3p";
const TUTORIAL_PLAYLIST_URL = `https://open.spotify.com/playlist/${TUTORIAL_PLAYLIST_ID}`;

// Tutorial notes fire at t=0, 6, 12, 18 on ANY currently-playing track.
// track_id is set to null so content.js fires them regardless of which song is playing.
function makeTutorialShare() {
  const now = Date.now();
  return {
    id: "ks-tutorial",
    mode: "editing",
    type: "playlist",
    playlist_id:   TUTORIAL_PLAYLIST_ID,
    playlist_url:  TUTORIAL_PLAYLIST_URL,
    playlist_name: "Keepsake Tutorial",
    sender_name:   "Keepsake",
    recipient_name: null,
    description: null,
    is_tutorial: true,
    imported: false,
    created_at: now,
    notes: [
      { id:"t1", track_id:null, timestamp:0,  is_tutorial:true, sender_name:"Keepsake", created_at:now,
        note:"Step 1: Open the side panel (the Keepsake icon). Write a thought for this moment. Hit Now to stamp the time, then Save." },
      { id:"t2", track_id:null, timestamp:6,  is_tutorial:true, sender_name:"Keepsake", created_at:now,
        note:"Step 2: Before sharing, add a description. Find the description box in the SHARE WITH panel. It shows on the page your friend sees." },
      { id:"t3", track_id:null, timestamp:12, is_tutorial:true, sender_name:"Keepsake", created_at:now,
        note:"Step 3: Hit SHARE in the panel to get your link. Send it to anyone — they see a beautiful keepsake card, even without the app." },
      { id:"t4", track_id:null, timestamp:18, is_tutorial:true, sender_name:"Keepsake", created_at:now,
        note:"Step 4: Received a keepsake? Open the link, click Import into Keepsake, then play the playlist — notes appear at the right moments." },
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
