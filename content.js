(() => {
  // ---- Track detection ----
  function getTrackInfo() {
    const nowPlaying = document.querySelector('[data-testid="now-playing-widget"]');
    let title = "", artist = "", trackId = "";
    if (nowPlaying) {
      const titleEl = nowPlaying.querySelector('[data-testid="context-item-link"], a[data-testid="context-item-link"]');
      if (titleEl) {
        title = titleEl.textContent.trim();
        const href = titleEl.getAttribute("href") || "";
        const m = href.match(/\/track\/([a-zA-Z0-9]+)/);
        if (m) trackId = m[1];
      }
      const artistEls = nowPlaying.querySelectorAll('a[href^="/artist/"]');
      artist = Array.from(artistEls).map((a) => a.textContent.trim()).join(", ");
    }
    if (!title) {
      const t = document.title || "";
      const m = t.match(/^Spotify\s*[–-]\s*(.+?)\s*·\s*(.+)$/);
      if (m) { title = m[1].trim(); artist = m[2].trim(); }
    }
    if (!trackId && title) trackId = `local:${title}::${artist}`;
    return { title, artist, trackId };
  }
  function parseTime(str) {
    if (!str) return null;
    const m = str.trim().match(/^(\d+):(\d{1,2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  function getPosition() {
    const el =
      document.querySelector('[data-testid="playback-position"]') ||
      document.querySelector('[data-testid="playback-progressbar-elapsed-time"]');
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

  // Lily SVG — inline hand-crafted asiatic lily illustration
  const FLORAL_SVG = `
    <svg viewBox="0 0 165 185" fill="none" stroke="#C4796A" stroke-width="1.3"
         stroke-linecap="round" stroke-linejoin="round"
         xmlns="http://www.w3.org/2000/svg">

      <!-- === MAIN STEM === -->
      <path d="M75,90 C74,112 73,133 74,157 C74,168 76,178 77,184"/>

      <!-- Branch to second flower -->
      <path d="M75,112 C91,106 110,90 130,74"/>

      <!-- Branch to bud -->
      <path d="M74,143 C65,140 57,137 50,132"/>

      <!-- Leaves -->
      <path d="M75,132 C63,126 51,122 41,121 C47,123 55,124 63,127"/>
      <path d="M75,150 C89,143 101,138 112,136 C107,138 102,140 97,143"/>

      <!-- === LILY 1 (center 75,87) === -->
      <!-- 6 petals -->
      <path d="M75,87 C68,74 67,58 75,48 C83,58 83,74 75,87Z"/>
      <path d="M75,87 C80,73 93,63 110,68 C103,76 89,81 75,87Z"/>
      <path d="M75,87 C84,83 98,85 110,105 C96,103 83,97 75,87Z"/>
      <path d="M75,87 C68,100 67,116 75,126 C83,116 83,100 75,87Z"/>
      <path d="M75,87 C66,85 52,85 40,105 C53,102 67,97 75,87Z"/>
      <path d="M75,87 C70,73 57,63 40,68 C47,76 61,81 75,87Z"/>
      <!-- Petal midrib lines for detail -->
      <path d="M75,87 C75,78 75,65 75,52" stroke-width="0.6" opacity="0.5"/>
      <path d="M75,87 C80,80 87,73 97,71" stroke-width="0.6" opacity="0.5"/>
      <path d="M75,87 C70,80 63,73 53,71" stroke-width="0.6" opacity="0.5"/>
      <!-- Stamens -->
      <line x1="75" y1="87" x2="75" y2="72"/>
      <line x1="75" y1="87" x2="87" y2="77"/>
      <line x1="75" y1="87" x2="88" y2="97"/>
      <line x1="75" y1="87" x2="63" y2="97"/>
      <line x1="75" y1="87" x2="63" y2="77"/>
      <circle cx="75" cy="71" r="1.5" fill="#C4796A"/>
      <circle cx="88" cy="76" r="1.5" fill="#C4796A"/>
      <circle cx="89" cy="98" r="1.5" fill="#C4796A"/>
      <circle cx="62" cy="98" r="1.5" fill="#C4796A"/>
      <circle cx="62" cy="76" r="1.5" fill="#C4796A"/>

      <!-- === LILY 2 (center 130,67) — slightly smaller === -->
      <path d="M130,67 C123,54 122,40 130,30 C138,40 138,54 130,67Z"/>
      <path d="M130,67 C134,53 146,46 160,50 C153,59 140,63 130,67Z"/>
      <path d="M130,67 C137,64 148,67 157,82 C146,77 135,72 130,67Z"/>
      <path d="M130,67 C123,79 122,93 130,102 C138,93 138,79 130,67Z"/>
      <path d="M130,67 C122,65 110,65 100,80 C111,75 123,70 130,67Z"/>
      <path d="M130,67 C126,53 114,46 100,50 C107,59 120,63 130,67Z"/>
      <!-- Petal midrib detail -->
      <path d="M130,67 C130,57 130,45 130,34" stroke-width="0.6" opacity="0.5"/>
      <!-- Stamens -->
      <line x1="130" y1="67" x2="130" y2="53"/>
      <line x1="130" y1="67" x2="141" y2="58"/>
      <line x1="130" y1="67" x2="119" y2="58"/>
      <circle cx="130" cy="52" r="1.3" fill="#C4796A"/>
      <circle cx="142" cy="57" r="1.3" fill="#C4796A"/>
      <circle cx="118" cy="57" r="1.3" fill="#C4796A"/>

      <!-- === BUD (off branch at 50,132) === -->
      <path d="M50,132 C47,127 44,121 45,114"/>
      <!-- Closed bud petals -->
      <path d="M45,114 C41,106 40,97 43,90 C44,87 47,86 49,89 C52,95 52,105 50,113"/>
      <path d="M45,114 C49,106 50,97 47,90 C49,86 52,87 53,91 C55,97 54,106 51,113"/>
      <!-- Bud sepals -->
      <path d="M47,110 C42,114 36,115 32,113"/>
      <path d="M48,105 C44,110 42,117 43,123"/>
    </svg>
  `;

  function showOverlay(note) {
    const sender = note.sender_name || "someone";
    const text = note.note || "";

    // Inject Playfair Display once — gracefully falls back to Georgia if Spotify CSP blocks it
    if (!document.getElementById("sn-playfair")) {
      const link = document.createElement("link");
      link.id = "sn-playfair";
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap";
      document.head.appendChild(link);
    }

    const wrap = document.createElement("div");
    wrap.className = "songnotes-overlay";
    wrap.innerHTML = `
      <div class="songnotes-card">
        <div class="songnotes-pin"></div>
        <button class="songnotes-close" aria-label="Dismiss">&#x00D7;</button>
        <div class="songnotes-body">
          <div class="songnotes-label"></div>
          <div class="songnotes-text"></div>
        </div>
        <div class="songnotes-floral">${FLORAL_SVG}</div>
      </div>
    `;
    wrap.querySelector(".songnotes-label").textContent = `✦  ${sender.toLowerCase()} sent you a note`;
    wrap.querySelector(".songnotes-text").textContent = text;
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
    wrap.querySelector(".songnotes-close").addEventListener("click", close);
    wrap.addEventListener("mouseenter", () => { if (timer) clearTimeout(timer); });
    wrap.addEventListener("mouseleave", () => startTimer(2000));
    wrap.querySelector(".songnotes-card").addEventListener("click", (e) => {
      if (e.target.classList.contains("songnotes-close")) return;
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
