(() => {
  // Guard against double-injection — Spotify's SPA navigation can cause Chrome
  // to re-inject content scripts without unloading the previous instance.
  // Without this, two setInterval loops run simultaneously and every note
  // fires twice on the same play-through.
  if (window.__ks_loaded) return;
  window.__ks_loaded = true;

  // ---- Track detection ----
  // Multiple selector fallbacks per element — if Spotify renames a testid,
  // the next candidate in the list takes over. Add new candidates at the end.
  const NOW_PLAYING_SELECTORS = [
    '[data-testid="now-playing-widget"]',
    '[data-testid="player-bar"]',
    '[data-testid="now-playing-bar"]',
    '.now-playing-bar',
    '[aria-label*="Now playing"]',
  ];
  const TITLE_SELECTORS = [
    '[data-testid="context-item-link"]',
    'a[data-testid="context-item-link"]',
    '[data-testid="track-info-name"] a',
    '[data-testid="track-title"] a',
    '.track-info__name a',
  ];
  const POSITION_SELECTORS = [
    '[data-testid="playback-position"]',
    '[data-testid="playback-progressbar-elapsed-time"]',
    '[data-testid="player-position"]',
    '.playback-bar__progress-time:first-child',
  ];

  function queryFirst(selectors, root) {
    const ctx = root || document;
    for (const sel of selectors) {
      try {
        const el = ctx.querySelector(sel);
        if (el) return el;
      } catch { /* invalid selector in future — skip */ }
    }
    return null;
  }

  function getTrackInfo() {
    const nowPlaying = queryFirst(NOW_PLAYING_SELECTORS);
    const detected = !!nowPlaying;
    let title = "", artist = "", trackId = "";

    // PRIMARY source: document.title — Spotify updates this immediately on every
    // song change, well before React finishes patching href attributes in the DOM.
    // Using it first means song changes are always detected on the very next poll.
    const docTitle = document.title || "";
    // Spotify formats: "Song • Artist" or "Spotify – Song · Artist"
    const dtMatch =
      docTitle.match(/^Spotify\s*[–-]\s*(.+?)\s*[·•]\s*(.+)$/) ||
      (!docTitle.startsWith("Spotify") && docTitle.match(/^(.+?)\s*[·•]\s*(.+)$/));
    if (dtMatch) { title = dtMatch[1].trim(); artist = dtMatch[2].trim(); }

    // ENHANCEMENT: try to get the real Spotify track ID from DOM links.
    // Cross-validate text vs our title so we don't pick up a stale href that
    // React hasn't updated yet (the root cause of the "stuck on first song" bug).
    if (nowPlaying) {
      const trackLinks = nowPlaying.querySelectorAll('a[href*="/track/"]');
      for (const link of trackLinks) {
        const m = link.getAttribute("href").match(/\/track\/([a-zA-Z0-9]+)/);
        if (m) {
          const linkText = link.textContent.trim();
          // Only trust this href if its visible text matches the title we already
          // know from document.title — if they differ, React hasn't flushed the
          // href update yet and the old track ID would cause a false "no change".
          if (!title || linkText === title) {
            trackId = m[1];
            if (!title) title = linkText;
          }
          break;
        }
      }

      // Artist from DOM (document.title sometimes omits featuring artists)
      const artistEls = nowPlaying.querySelectorAll('a[href^="/artist/"]');
      if (artistEls.length) artist = Array.from(artistEls).map((a) => a.textContent.trim()).join(", ");
    }

    // URL fallback (when user navigated directly to a track page)
    if (!trackId) {
      const m = location.href.match(/\/track\/([a-zA-Z0-9]+)/);
      if (m) trackId = m[1];
    }

    // og:title fallback for title
    if (!title) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og) title = og.getAttribute("content")?.trim() || "";
    }

    // Final fallback: derive a surrogate track ID from title+artist.
    // This still changes with every song so the popup's change detection works
    // even when no real Spotify track URL can be found.
    if (!trackId && title) trackId = `local:${title}::${artist}`;

    return { title, artist, trackId, playerVisible: detected };
  }
  function parseTime(str) {
    if (!str) return null;
    const m = str.trim().match(/^(\d+):(\d{1,2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  function getPosition() {
    const el = queryFirst(POSITION_SELECTORS);
    if (el) return parseTime(el.textContent);
    return null;
  }

  // ---- State ----
  let lastTrackId = null;
  let lastPosition = -1;
  // firedNotes is keyed per share so multiple shares can each fire independently.
  let firedNotes = new Set(); // entries like "<shareId>::<noteId>"

  async function loadActiveShare() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["ks_shares"], (data) => {
        const store = data.ks_shares || {};
        const active = store.active && store.shares ? store.shares[store.active] : null;
        resolve(active || null);
      });
    });
  }

  // ---- Overlay ----
  function durationFor(text) {
    const words = text.trim().split(/\s+/).length;
    return Math.min(15000, Math.max(4000, 4000 + words * 450));
  }

  // Pick font tier based on note length
  function textSizeClass(len) {
    if (len < 60)  return "sn-large";   // 28px Playfair
    if (len < 140) return "sn-medium";  // 20px Playfair
    return "sn-small";                  // 13.5px system font
  }

  function showOverlay(note) {
    const sender = note.sender_name || "someone";
    const raw    = note.note || "";
    const text   = raw.length > 260 ? raw.slice(0, 257) + "…" : raw;

    // Inject Playfair Display once — falls back to Georgia if Spotify's CSP blocks it
    if (!document.getElementById("sn-playfair")) {
      const link = document.createElement("link");
      link.id   = "sn-playfair";
      link.rel  = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@1,400&display=swap";
      document.head.appendChild(link);
    }

    const wrap = document.createElement("div");
    wrap.className = "ks-overlay";
    wrap.innerHTML = `
      <div class="ks-card">
        <button class="ks-close" aria-label="Dismiss">&#x00D7;</button>
        <div class="ks-label"></div>
        <div class="ks-text ${textSizeClass(text.length)}"></div>
      </div>
    `;

    // Set background image via extension URL (required for content scripts in MV3)
    wrap.querySelector(".ks-card").style.backgroundImage =
      `url('${chrome.runtime.getURL("floater.png")}')`;

    wrap.querySelector(".ks-label").textContent = `✦  ${sender.toLowerCase()} sent you a note`;
    wrap.querySelector(".ks-text").textContent  = text;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("visible"));

    let pinned = false;
    let timer = null;
    const totalMs = durationFor(text);
    const close = () => {
      if (timer) clearTimeout(timer);
      wrap.classList.remove("visible");
      setTimeout(() => wrap.remove(), 500);
    };
    const startTimer = (ms) => {
      if (pinned) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(close, ms);
    };
    wrap.querySelector(".ks-close").addEventListener("click", close);
    wrap.addEventListener("mouseenter", () => { if (timer) clearTimeout(timer); });
    wrap.addEventListener("mouseleave", () => startTimer(2000));
    wrap.querySelector(".ks-card").addEventListener("click", (e) => {
      if (e.target.classList.contains("ks-close")) return;
      pinned = !pinned;
      wrap.classList.toggle("pinned", pinned);
      if (pinned && timer) clearTimeout(timer);
      else startTimer(2500);
    });
    startTimer(totalMs);
  }

  // ---- Loop ----
  async function tick() {
    const info = getTrackInfo();
    if (!info.trackId) return;

    const share = await loadActiveShare();
    // Inactive mode (or no active share) = never show popups.
    if (!share || share.mode === "inactive") {
      lastTrackId = info.trackId;
      lastPosition = getPosition() ?? -1;
      return;
    }

    // Track change: reset fired set scoped to current share
    if (info.trackId !== lastTrackId) {
      lastTrackId = info.trackId;
      lastPosition = -1;
      firedNotes = new Set();
      // Push track change directly to the side panel — more reliable than
      // the panel polling via sendMessage, which can be blocked by the
      // side panel's document.hidden state or currentWindow resolution.
      chrome.runtime.sendMessage({
        type: "KS_TRACK_CHANGED",
        trackId: info.trackId,
        title:   info.title,
        artist:  info.artist,
      }).catch(() => {}); // panel may not be open — that's fine
      // Fire "song start" notes (timestamp == null) for matching tracks
      share.notes
        .filter((n) => n.track_id === info.trackId && n.timestamp == null)
        .forEach((n) => {
          const k = `${share.id}::${n.id}`;
          if (!firedNotes.has(k)) { firedNotes.add(k); showOverlay(n); }
        });
    }

    const pos = getPosition();
    if (pos == null) return;
    // If user scrubbed back, allow re-firing notes that come after current position
    if (pos < lastPosition - 2) {
      const stillFired = new Set();
      share.notes.forEach((n) => {
        if (n.track_id !== info.trackId) return;
        if (n.timestamp != null && n.timestamp < pos - 1) stillFired.add(`${share.id}::${n.id}`);
      });
      firedNotes = stillFired;
    }
    lastPosition = pos;

    share.notes.forEach((n) => {
      // STRICT: track_id must match the currently playing track
      if (n.track_id !== info.trackId) return;
      const k = `${share.id}::${n.id}`;
      if (n.timestamp != null && !firedNotes.has(k)) {
        if (pos >= n.timestamp && pos <= n.timestamp + 2) {
          firedNotes.add(k);
          showOverlay(n);
        }
      }
    });
  }

  setInterval(tick, 800);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "KS_GET_STATE") {
      const info = getTrackInfo();
      const pos = getPosition();
      sendResponse({ ...info, position: pos });
      return true;
    }
    if (msg && msg.type === "KS_REFRESH") {
      // No state reset needed — tick() calls loadActiveShare() every 800ms so
      // new notes are picked up automatically. Resetting lastTrackId/firedNotes
      // here would cause all already-passed notes to re-fire as duplicate toasts.
      sendResponse({ ok: true });
      return true;
    }
  });
})();
