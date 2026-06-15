// Open the side panel when the user clicks the extension icon.
// setPanelBehavior persists across sessions so this only needs to run once,
// but calling it on every service-worker startup is harmless.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// ── Tutorial / onboarding ──────────────────────────────────────────────────
// The tutorial is a decoupled overlay stored under its own key (ks_tutorial),
// NOT a share — the user's real shares stay separate and auto-saved.
// Tutorial notes fire every 7 seconds on ANY currently-playing track
// (no track_id). IMPORTANT: keep this copy + TUTORIAL_VERSION in sync with
// popup.js (buildTutorialNotes). popup.js self-heals stale installs on bump.
const TUTORIAL_TOTAL = 12;
const TUTORIAL_VERSION = 11;
function mkNote(id, step, ts, title, text) {
  return { id, timestamp: ts, is_tutorial: true,
           tutorial_step: step, tutorial_total: TUTORIAL_TOTAL,
           sender_name: "Keepsake", title, note: text };
}
function makeTutorialOverlay(active) {
  return {
    active: !!active,
    version: TUTORIAL_VERSION,
    nameCardPending: !!active, // first panel open leads with the name card
    notes: [
      mkNote("t01", 1,  0,   "Welcome to Keepsake", "A few little notes to help you find your way.\nTo begin, open the side panel by clicking the Keepsake icon in your browser toolbar."),
      mkNote("t02", 2,  10,  "Good to know", "These little notes appear as the song plays.\nIf you pause or rewind, they'll pop up again, so nothing slips by."),
      mkNote("t03", 3,  20,  "Start with your name", "It's the signature on every keepsake you send, so whoever opens one knows it came from you."),
      mkNote("t04", 4,  30,  "Who is it for?", "Add their name in the panel.\nWhoever's on your mind right now, this one's for them."),
      mkNote("t05", 5,  40,  "Write your note", "Whatever this moment in the song stirs in you, write it down here."),
      mkNote("t06", 6,  50,  "Pin it to the second", "Tap **Now** to catch the current moment or type in a timestamp if another part of the song is calling you."),
      mkNote("t07", 7,  60,  "Save it", "Hit **Save note** and it's sealed.\nAdd as many notes as you'd like, across as many songs as you wish."),
      mkNote("t08", 8,  70,  "Add a description", "Scroll to the share panel and leave a little description.\nIt's the first thing they read, before the music begins."),
      mkNote("t09", 9,  80,  "Share it", "Hit **Share** to get your link.\nWrote across a few songs? You'll drop in the playlist link first."),
      mkNote("t10", 10, 90,  "Send it off", "To anyone, anywhere.\nIt opens as a quiet little card holding every note you left. Once they install Keepsake, those notes appear as the music plays."),
      mkNote("t11", 11, 100, "Relive anywhere", "Turn on **Cross-device Relive** and choose a private passphrase.\nIt securely ties your keepsakes to your account, so they'll be waiting for you even on a new device. Your passphrase stays with you, which means only you can unlock them."),
      mkNote("t12", 12, 110, "That's everything", "Now go make someone's day. ✦"),
    ],
  };
}

function createDemoShare(force = false) {
  chrome.storage.local.get(["ks_onboarding"], (data) => {
    const onboarding = data.ks_onboarding || {};
    if (!force && onboarding.started) return; // already set up
    // Tutorial is stored but NOT armed at install — we don't yet know whether this
    // is an organic install or a recipient who came via a share link. The make-tour
    // is armed later: organically on first side-panel open (popup.js init), or for a
    // recipient only after they close the keepsake they were sent (receivedClose).
    chrome.storage.local.set({
      ks_tutorial: makeTutorialOverlay(false),
      ks_onboarding: { started: true, seen: false, phase: "fresh" },
    });
  });
}

// Fire on fresh install: set up neutral onboarding state + open the getting-started
// page. welcome.html decides organic vs recipient content from the ks_pending_share
// breadcrumb; the make-tour is armed later, not here.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    createDemoShare();
    chrome.tabs.create({ url: "https://dropakeepsake.com/welcome.html" });
  }
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
