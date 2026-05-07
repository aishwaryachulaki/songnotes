(() => {
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
    let title = "", artist = "", trackId = "";
    // detected = true means we found the player container, even if track parse fails
    const detected = !!nowPlaying;

    if (nowPlaying) {
      const titleEl = queryFirst(TITLE_SELECTORS, nowPlaying);
      if (titleEl) {
        title = titleEl.textContent.trim();
        const href = titleEl.getAttribute("href") || "";
        const m = href.match(/\/track\/([a-zA-Z0-9]+)/);
        if (m) trackId = m[1];
      }
      const artistEls = nowPlaying.querySelectorAll('a[href^="/artist/"]');
      artist = Array.from(artistEls).map((a) => a.textContent.trim()).join(", ");
    }

    // Fallback 1: document.title ("Spotify – Song · Artist")
    if (!title) {
      const t = document.title || "";
      const m = t.match(/^Spotify\s*[–-]\s*(.+?)\s*[·•]\s*(.+)$/);
      if (m) { title = m[1].trim(); artist = m[2].trim(); }
    }

    // Fallback 2: og:title meta tag (some Spotify pages set this)
    if (!title) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og) title = og.getAttribute("content")?.trim() || "";
    }

    if (!trackId && title) trackId = `local:${title}::${artist}`;

    // playerVisible tells the popup whether we can see the Spotify player at all,
    // so it can show a helpful message if selectors broke vs. Spotify just not open
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
      chrome.storage.local.get(["sn_shares"], (data) => {
        const store = data.sn_shares || {};
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
    if (msg && msg.type === "SN_GET_STATE") {
      const info = getTrackInfo();
      const pos = getPosition();
      sendResponse({ ...info, position: pos });
      return true;
    }
    if (msg && msg.type === "SN_REFRESH") {
      // Force re-evaluation on next tick by clearing the per-track cache
      lastTrackId = null;
      firedNotes = new Set();
      sendResponse({ ok: true });
      return true;
    }
  });
})();
