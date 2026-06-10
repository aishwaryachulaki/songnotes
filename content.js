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

  // ---- Playback-aware overlay timers ----
  // While the song is paused, open notes hold on screen (their auto-dismiss
  // timer freezes) so they can be read; they resume counting down on play.
  const activeOverlays = new Set();
  let playbackPaused = false;
  let samePosTicks = 0; // consecutive ticks with an unchanged position => paused
  function setPlaybackPaused(paused) {
    if (paused === playbackPaused) return;
    playbackPaused = paused;
    activeOverlays.forEach((o) => (paused ? o.hold("paused") : o.release("paused")));
  }

  // Loads both the user's active share AND the (decoupled) tutorial overlay.
  // The tutorial lives in its own key so it never mixes with — or pollutes —
  // the user's real keepsakes.
  async function loadState() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["ks_shares", "ks_tutorial"], (data) => {
        const store = data.ks_shares || {};
        const active = store.active && store.shares ? store.shares[store.active] : null;
        const tut = data.ks_tutorial;
        resolve({
          share: active || null,
          tutorial: (tut && tut.active && Array.isArray(tut.notes)) ? tut : null,
        });
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
    const isTutorial = !!note.is_tutorial;
    const sender = note.sender_name || "someone";
    // Trim leading/trailing whitespace so a stray trailing space/newline can't
    // push the text past the paper or bump it into a larger size tier.
    const raw    = (note.note || "").trim();
    const text   = raw.length > 260 ? raw.slice(0, 257) + "…" : raw;

    // Step number for the tutorial badge (from note field, or legacy "Step N:" prefix)
    const legacyMatch = isTutorial && text.match(/^Step\s+(\d+)/i);
    const stepNum     = note.tutorial_step || (legacyMatch ? parseInt(legacyMatch[1], 10) : null);
    const stepTotal   = note.tutorial_total || 10;

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
      <div class="ks-card${isTutorial ? " ks-card--tutorial" : ""}">
        <button class="ks-close" aria-label="Dismiss">&#x00D7;</button>
        ${isTutorial && stepNum ? `<div class="ks-step-badge">✦ STEP ${stepNum} OF ${stepTotal}</div>` : `<div class="ks-label"></div>`}
        ${isTutorial && note.title ? `<div class="ks-tut-title"></div>` : ""}
        <div class="ks-text ${isTutorial ? "ks-tut-text" : textSizeClass(text.length)}"></div>
      </div>
    `;

    // Set background image via extension URL (required for content scripts in MV3)
    const card = wrap.querySelector(".ks-card");
    if (isTutorial) {
      card.style.backgroundImage = `url('${chrome.runtime.getURL("faq-bg-yellow.png")}')`;
    } else {
      card.style.backgroundImage = `url('${chrome.runtime.getURL("floater.png")}')`;
    }

    if (!isTutorial) {
      wrap.querySelector(".ks-label").textContent = `✦  ${sender.toLowerCase()} sent you a note`;
    } else if (note.title) {
      wrap.querySelector(".ks-tut-title").textContent = note.title;
    }
    const textEl = wrap.querySelector(".ks-text");
    if (isTutorial) {
      // Tutorial copy is our own static text — render **bold** markers as <strong>.
      // HTML-escape first; real notes stay textContent (never innerHTML) for safety.
      const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      textEl.innerHTML = esc.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    } else {
      textEl.textContent = text;
    }
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("visible"));

    // Hold-based dismiss timer. The countdown only runs when nothing is
    // holding it: hovering, pinning, OR the song being paused all hold it.
    let timer = null;
    let remaining = durationFor(text);
    let countdownStart = 0;
    const holds = new Set();
    if (playbackPaused) holds.add("paused"); // shown during a pause → wait to count down

    const close = () => {
      if (timer) clearTimeout(timer);
      activeOverlays.delete(controller);
      wrap.classList.remove("visible");
      setTimeout(() => wrap.remove(), 500);
    };
    const run = () => {
      if (timer) clearTimeout(timer);
      if (holds.size) return;            // held — don't count down
      countdownStart = Date.now();
      timer = setTimeout(close, remaining);
    };
    const hold = (reason) => {
      holds.add(reason);
      if (timer) {                       // freeze whatever time is left
        clearTimeout(timer); timer = null;
        remaining = Math.max(0, remaining - (Date.now() - countdownStart));
      }
    };
    const release = (reason) => {
      holds.delete(reason);
      if (!holds.size) run();
    };
    const controller = { hold, release, close };
    activeOverlays.add(controller);

    wrap.querySelector(".ks-close").addEventListener("click", close);
    wrap.addEventListener("mouseenter", () => hold("hover"));
    wrap.addEventListener("mouseleave", () => release("hover"));
    wrap.querySelector(".ks-card").addEventListener("click", (e) => {
      if (e.target.classList.contains("ks-close")) return;
      const pinned = wrap.classList.toggle("pinned");
      if (pinned) hold("pin"); else release("pin");
    });
    run();
  }

  // ---- Loop ----
  async function tick() {
    const info = getTrackInfo();
    if (!info.trackId) return;

    const { share, tutorial } = await loadState();
    const shareActive = share && share.mode !== "inactive";

    // Nothing to show from either source.
    if (!shareActive && !tutorial) {
      lastTrackId = info.trackId;
      lastPosition = getPosition() ?? -1;
      return;
    }

    // Track change: reset fired set; fire song-start notes for both sources.
    if (info.trackId !== lastTrackId) {
      lastTrackId = info.trackId;
      lastPosition = -1;
      firedNotes = new Set();
      chrome.runtime.sendMessage({
        type: "KS_TRACK_CHANGED",
        trackId: info.trackId,
        title:   info.title,
        artist:  info.artist,
      }).catch(() => {}); // panel may not be open — that's fine

      // Tutorial: fires on ANY track. Song-start = timestamp 0.
      if (tutorial) {
        tutorial.notes.forEach((n) => {
          if (n.timestamp !== 0) return;
          const k = `tutorial::${n.id}`;
          if (!firedNotes.has(k)) { firedNotes.add(k); showOverlay(n); }
        });
      }
      // Real notes: only for the matching track, song-start = timestamp null.
      if (shareActive) {
        share.notes
          .filter((n) => n.track_id === info.trackId && n.timestamp == null)
          .forEach((n) => {
            const k = `${share.id}::${n.id}`;
            if (!firedNotes.has(k)) { firedNotes.add(k); showOverlay(n); }
          });
      }
    }

    const pos = getPosition();
    if (pos == null) return;

    // Pause detection: while playing, the position advances every ~1s; a
    // value frozen across 2+ ticks (~1.6s, longer than the 800ms tick) means
    // the song is paused. Holds open notes on screen until playback resumes.
    if (pos === lastPosition) samePosTicks++;
    else samePosTicks = 0;
    setPlaybackPaused(samePosTicks >= 2);

    // Scrub-back: re-arm notes that come after the new position.
    if (pos < lastPosition - 2) {
      const stillFired = new Set();
      if (tutorial) tutorial.notes.forEach((n) => {
        if (n.timestamp != null && n.timestamp < pos - 1) stillFired.add(`tutorial::${n.id}`);
      });
      if (shareActive) share.notes.forEach((n) => {
        if (n.track_id !== info.trackId) return;
        if (n.timestamp != null && n.timestamp < pos - 1) stillFired.add(`${share.id}::${n.id}`);
      });
      firedNotes = stillFired;
    }
    lastPosition = pos;

    // Timestamp-based firing.
    if (tutorial) {
      tutorial.notes.forEach((n) => {
        const k = `tutorial::${n.id}`;
        if (n.timestamp != null && !firedNotes.has(k)) {
          if (pos >= n.timestamp && pos <= n.timestamp + 2) { firedNotes.add(k); showOverlay(n); }
        }
      });
    }
    if (shareActive) {
      share.notes.forEach((n) => {
        if (n.track_id !== info.trackId) return;
        const k = `${share.id}::${n.id}`;
        if (n.timestamp != null && !firedNotes.has(k)) {
          if (pos >= n.timestamp && pos <= n.timestamp + 2) { firedNotes.add(k); showOverlay(n); }
        }
      });
    }
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
      // No state reset needed — tick() calls loadState() every 800ms so
      // new notes are picked up automatically. Resetting lastTrackId/firedNotes
      // here would cause all already-passed notes to re-fire as duplicate toasts.
      sendResponse({ ok: true });
      return true;
    }
  });
})();
