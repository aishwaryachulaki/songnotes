const $ = (id) => document.getElementById(id);
const { SUPABASE_URL, SUPABASE_KEY, SHARE_ORIGIN: CONFIGURED_ORIGIN } = window.SN_CONFIG;

// ---------- auth ----------
let _session = null; // cached session from chrome.storage

async function getSession() {
  if (_session && _session.expires_at > Date.now() / 1000 + 30) return _session;
  const data = await chrome.storage.local.get("sn_session");
  if (!data.sn_session) return null;
  const s = data.sn_session;
  // If expired, attempt silent refresh via Supabase token endpoint
  if (s.expires_at && s.expires_at < Date.now() / 1000 + 30) {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      });
      if (res.ok) {
        const fresh = await res.json();
        const updated = {
          access_token: fresh.access_token,
          refresh_token: fresh.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + fresh.expires_in,
          user: s.user,
        };
        await chrome.storage.local.set({ sn_session: updated });
        _session = updated;
        return updated;
      }
    } catch {}
    // Refresh failed — session is dead
    await chrome.storage.local.remove("sn_session");
    return null;
  }
  _session = s;
  return s;
}

async function supabaseRpc(fnName, params, accessToken) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) return { data: null, error: await res.text() };
  const data = await res.json();
  return { data, error: null };
}

async function fetchCredits(accessToken, userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_credits?user_id=eq.${encodeURIComponent(userId)}&select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || { paid_credits: 0, lifetime: false, monthly_free_used_at: null };
}

function creditsFreeAvailable(c) {
  if (!c || !c.monthly_free_used_at) return true;
  const used = new Date(c.monthly_free_used_at);
  const now = new Date();
  return used.getFullYear() < now.getFullYear() ||
    (used.getFullYear() === now.getFullYear() && used.getMonth() < now.getMonth());
}

function creditsLabel(c) {
  if (!c) return "0 letters";
  if (c.lifetime) return "∞ Lifetime";
  const free = creditsFreeAvailable(c) ? 1 : 0;
  const total = c.paid_credits + free;
  return `${total} letter${total !== 1 ? "s" : ""}`;
}

function openAuthPage() {
  const url = `https://aishwaryachulaki.github.io/songnotes/auth.html`;
  chrome.tabs.create({ url });
}

function openAccountPage() {
  const url = `https://aishwaryachulaki.github.io/songnotes/account.html`;
  chrome.tabs.create({ url });
}

// ---------- helpers ----------
function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function shortId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 10);
}
function parseTimestamp(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
}
function formatTs(sec) {
  if (sec == null) return "Song start";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
// Returns only structurally valid notes — guards share/import paths.
function sanitizeNotes(notes) {
  return (notes || []).filter((n) => n && n.id && n.note && n.track_id);
}

function parsePlaylistId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/playlist\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9]{10,40}$/.test(s)) return s;
  return null;
}

// ---------- share-scoped storage model ----------
// sn_shares = {
//   active: "<id>",
//   shares: {
//     [id]: { id, mode: "editing"|"preview"|"inactive",
//             type: "single"|"multi"|"playlist",
//             playlist_id, playlist_url, sender_name,
//             notes: [{id, track_id, track_title, track_artist, note, timestamp, sender_name, created_at}],
//             imported: bool, created_at }
//   },
//   previous: ["<id>", ...]   // archived (most recent first)
// }
async function loadStore() {
  const data = await chrome.storage.local.get(["sn_shares", "sn_sender"]);
  const store = data.sn_shares || { active: null, shares: {}, previous: [] };
  return { store, sender: data.sn_sender || "" };
}
async function saveStore(store) {
  await chrome.storage.local.set({ sn_shares: store });
}
function ensureActive(store, sender) {
  if (!store.active || !store.shares[store.active]) {
    const id = shortId();
    store.shares[id] = {
      id,
      mode: "editing",
      type: "single",
      playlist_id: null,
      playlist_url: null,
      sender_name: sender || "someone",
      recipient_name: null,
      notes: [],
      imported: false,
      created_at: Date.now(),
    };
    store.active = id;
  }
  return store.shares[store.active];
}
function deriveType(share) {
  if (share.playlist_id || share.playlist_url) return "playlist";
  const trackIds = new Set(share.notes.map((n) => n.track_id));
  return trackIds.size > 1 ? "multi" : "single";
}

// ---------- state ----------
let currentTrack = null;
let senderName = "";
let shareOrigin = CONFIGURED_ORIGIN || "";
let activeShare = null; // reference into store.shares[active]

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function fetchTrack() {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.includes("open.spotify.com")) return null;
  try { return await chrome.tabs.sendMessage(tab.id, { type: "SN_GET_STATE" }); } catch { return null; }
}
async function notifyContentRefresh() {
  const tab = await getActiveTab();
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "SN_REFRESH" }).catch(() => {});
}

// ---------- backend ----------
async function pushShareMeta(share) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/shares`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        id: share.id,
        share_type: share.type,
        playlist_id: share.playlist_id,
        playlist_url: share.playlist_url,
        sender_name: share.sender_name || senderName || "someone",
      }),
    });
  } catch {}
}
async function pushNote(share, note) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/annotations`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        track_id: note.track_id,
        note: note.note,
        timestamp: note.timestamp,
        sender_name: note.sender_name || senderName || "someone",
        share_id: share.id,
        track_title: note.track_title || null,
        track_artist: note.track_artist || null,
        playlist_id: share.playlist_id || null,
      }),
    });
    return res.ok;
  } catch { return false; }
}
async function deleteNoteRemote(id) {
  // Works for imported notes (id === Supabase row id).
  // For locally-created notes the id won't match any row — silently no-ops.
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/annotations?id=eq.${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
  } catch {}
}

async function fetchShareNotes(id) {
  const url = `${SUPABASE_URL}/rest/v1/annotations?share_id=eq.${encodeURIComponent(id)}&select=*`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) return [];
  return await res.json();
}
async function fetchShareMeta(id) {
  const url = `${SUPABASE_URL}/rest/v1/shares?id=eq.${encodeURIComponent(id)}&select=*`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) return null;
  const arr = await res.json();
  return arr[0] || null;
}

function shareUrl(id) {
  if (!shareOrigin) return id; // no host yet — just show the ID
  return `${shareOrigin}/share.html?id=${id}`;
}

// ---------- rendering ----------
function setMode(mode) {
  // Banner has been removed from the DOM; this is a no-op kept for call-site compatibility.
  const m = mode === "inactive" ? "inactive" : "editing";
  const banner = $("modeBanner");
  if (!banner) return;
  banner.classList.remove("mode-editing", "mode-preview", "mode-inactive");
  banner.classList.add(`mode-${m}`);
  const labels = {
    editing: "Editing — your popups will appear as you listen",
    inactive: "Shared ✓ — popups are off for you now",
  };
  $("modeLabel").textContent = labels[m];
}

async function renderNotes() {
  const list = $("notes");
  if (!currentTrack || !activeShare) {
    list.innerHTML = '<div class="empty">No song detected.</div>';
    return;
  }
  const notes = activeShare.notes.filter((n) => n.track_id === currentTrack.trackId);
  if (!notes.length) {
    list.innerHTML = '<div class="empty">No notes on this song yet.</div>';
    return;
  }
  list.innerHTML = "";
  notes.slice().sort((a, b) => (a.timestamp ?? -1) - (b.timestamp ?? -1)).forEach((n) => {
    const div = document.createElement("div");
    div.className = "note";
    div.innerHTML = `<div class="meta">${formatTs(n.timestamp)}</div><div>${escapeHtml(n.note)}</div><button class="del" data-id="${n.id}" title="Delete">×</button>`;
    list.appendChild(div);
  });
  list.querySelectorAll(".del").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const deletedId = e.currentTarget.dataset.id;
      const { store } = await loadStore();
      // Remove this note from EVERY share so no archived copy keeps it alive.
      for (const shareId in store.shares) {
        store.shares[shareId].notes = store.shares[shareId].notes.filter(
          (n) => n.id !== deletedId
        );
      }
      await saveStore(store);
      // Keep the module-level reference consistent with the saved store.
      activeShare.notes = store.shares[activeShare.id]?.notes ?? [];
      // Best-effort remote delete (works when id is a Supabase row id).
      deleteNoteRemote(deletedId);
      renderNotes();
      renderSummary();
      notifyContentRefresh();
    }),
  );
}

function renderSummary() {
  if (!activeShare) return;
  const ownNotes = activeShare.notes;
  const songCount = new Set(ownNotes.map((n) => n.track_id)).size;
  const noteCount = ownNotes.length;
  const el = $("shareSummary");
  if (!noteCount) {
    el.textContent = "No notes yet — write one above to start a shared experience.";
  } else {
    const t = deriveType(activeShare);
    const tag = t === "playlist" ? " · playlist" : t === "multi" ? " · across multiple songs" : "";
    el.textContent = `${noteCount} note${noteCount === 1 ? "" : "s"} across ${songCount} song${songCount === 1 ? "" : "s"}${tag}`;
  }

}

async function renderPrevious() {
  const { store } = await loadStore();
  const list = $("previousList");
  const prev = (store.previous || [])
    .filter((id) => store.shares[id])
    .slice(0, 3);
  if (!prev.length) { list.innerHTML = ""; return; }
  list.innerHTML = '<div class="prev-header">Previous experiences</div>';
  prev.forEach((id) => {
    const s = store.shares[id];
    const noteCount = s.notes.length;
    const songCount = new Set(s.notes.map((n) => n.track_id)).size;
    const title = s.recipient_name
      ? `Notes for ${s.recipient_name}`
      : "Notes (unknown recipient)";
    // Short date, e.g. "Apr 27"
    const dateStr = s.created_at
      ? new Date(s.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : null;
    const sub = [
      `${noteCount} note${noteCount === 1 ? "" : "s"}`,
      `${songCount} song${songCount === 1 ? "" : "s"}`,
      dateStr,
    ].filter(Boolean).join(" · ");
    const row = document.createElement("div");
    row.className = "prev-item";
    row.innerHTML = `
      <div class="prev-meta">
        <div class="prev-title">${escapeHtml(title)}</div>
        <div class="prev-sub">${escapeHtml(sub)}</div>
      </div>
      <button class="btn prev-activate" data-id="${id}">Reactivate</button>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll(".prev-activate").forEach((b) =>
    b.addEventListener("click", async (e) => {
      await activateShare(e.currentTarget.dataset.id);
    }),
  );

  if ((store.previous || []).filter((id) => store.shares[id]).length > 3) {
    const more = document.createElement("div");
    more.className = "prev-more";
    more.textContent = "View more on your account →";
    list.appendChild(more);
  }
}

function showComposer(show) {
  $("composer").classList.toggle("hidden", !show);
  $("nameBlock").classList.toggle("hidden", show);
  if (show) $("whoami").textContent = senderName;
}

// ---------- share lifecycle ----------
async function archiveActive(store) {
  if (!store.active) return;
  store.previous = [store.active, ...(store.previous || []).filter((x) => x !== store.active)];
}
async function activateShare(id) {
  const { store } = await loadStore();
  if (!store.shares[id]) return;
  if (store.active && store.active !== id) {
    await archiveActive(store);
  }
  store.previous = (store.previous || []).filter((x) => x !== id);
  store.active = id;
  await saveStore(store);
  activeShare = store.shares[id];
  $("recipientName").value = activeShare.recipient_name || "";
  setMode(activeShare.mode || "editing");
  renderNotes();
  renderSummary();
  renderPrevious();
  notifyContentRefresh();
}

async function init() {
  const { store, sender } = await loadStore();
  senderName = sender;
  chrome.storage.local.remove("sn_share_origin");
  shareOrigin = CONFIGURED_ORIGIN || "";

  activeShare = ensureActive(store, senderName);
  await saveStore(store);

  const state = await fetchTrack();
  if (state && state.trackId) {
    currentTrack = state;
    $("trackTitle").textContent = state.title || "Unknown track";
    $("trackArtist").textContent = state.artist || "";
  } else {
    $("trackTitle").textContent = "No song detected";
    $("trackArtist").textContent = "Open Spotify Web Player to start";
  }

  $("playlistUrl").value = activeShare.playlist_url || "";
  $("recipientName").value = activeShare.recipient_name || "";
  setMode(activeShare.mode || "editing");
  showComposer(!!senderName);
  renderNotes();
  renderSummary();
  renderPrevious();

  // ── Auth UI ──
  const session = await getSession();
  if (session) {
    $("authGate").classList.add("hidden");
    $("authBar").classList.remove("hidden");
    $("authEmail").textContent = session.user?.email || "";
    // Fetch and show credits
    const c = await fetchCredits(session.access_token, session.user.id);
    const badge = $("creditsBadge");
    badge.textContent = creditsLabel(c);
    if (c && !c.lifetime && c.paid_credits === 0 && !creditsFreeAvailable(c)) badge.classList.add("empty");
  } else {
    $("authGate").classList.remove("hidden");
    $("authBar").classList.add("hidden");
  }
}

// ---------- handlers ----------

// Auth button handlers
$("signInBtn").addEventListener("click", openAuthPage);
$("accountLink").addEventListener("click", (e) => { e.preventDefault(); openAccountPage(); });
$("signOutLink").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.storage.local.remove("sn_session");
  _session = null;
  $("authGate").classList.remove("hidden");
  $("authBar").classList.add("hidden");
});

$("saveName").addEventListener("click", async () => {
  const v = $("senderName").value.trim();
  if (!v) return;
  senderName = v;
  await chrome.storage.local.set({ sn_sender: v });
  if (activeShare) {
    activeShare.sender_name = v;
    const { store } = await loadStore();
    store.shares[activeShare.id] = activeShare;
    await saveStore(store);
  }
  showComposer(true);
});
$("changeName").addEventListener("click", (e) => {
  e.preventDefault();
  $("senderName").value = senderName;
  showComposer(false);
});
$("recipientName").addEventListener("input", async () => {
  if (!activeShare) return;
  activeShare.recipient_name = $("recipientName").value.trim() || null;
  const { store } = await loadStore();
  store.shares[activeShare.id] = activeShare;
  await saveStore(store);
});

$("useCurrent").addEventListener("click", async () => {
  const state = await fetchTrack();
  if (state && state.position != null) $("ts").value = formatTs(Math.floor(state.position));
});

$("save").addEventListener("click", async () => {
  const btn = $("save");
  if (btn.disabled) return;
  btn.disabled = true;
  const text = $("note").value.trim();
  if (!text) { btn.disabled = false; return ($("status").textContent = "Note can't be empty."); }
  if (!currentTrack) { btn.disabled = false; return ($("status").textContent = "No song detected."); }
  const ts = parseTimestamp($("ts").value);
  const note = {
    id: uuid(),
    track_id: currentTrack.trackId,
    track_title: currentTrack.title || null,
    track_artist: currentTrack.artist || null,
    note: text,
    timestamp: ts,
    sender_name: senderName,
    created_at: Date.now(),
  };
  // Adding a note flips back to editing (in case we were inactive/preview).
  activeShare.notes.push(note);
  activeShare.mode = "editing";
  activeShare.type = deriveType(activeShare);
  const { store } = await loadStore();
  store.shares[activeShare.id] = activeShare;
  await saveStore(store);
  setMode("editing");

  const ok = await pushNote(activeShare, note);
  btn.disabled = false;
  $("note").value = "";
  $("ts").value = "";
  $("status").textContent = ok ? "Saved & shared ✓" : "Saved locally ✓";
  setTimeout(() => ($("status").textContent = ""), 2000);
  renderNotes();
  renderSummary();
  notifyContentRefresh();
});

$("playlistUrl").addEventListener("change", async () => {
  const v = $("playlistUrl").value.trim();
  activeShare.playlist_url = v || null;
  activeShare.playlist_id = parsePlaylistId(v);
  activeShare.type = deriveType(activeShare);
  const { store } = await loadStore();
  store.shares[activeShare.id] = activeShare;
  await saveStore(store);
  renderSummary();
});

$("copyShare").addEventListener("click", async () => {
  const shareBtn = $("copyShare");
  if (shareBtn.disabled) return;
  shareBtn.disabled = true;

  // ── Auth + credit check ──
  const session = await getSession();
  if (!session) {
    $("shareInfo").innerHTML = `Sign in to send letters. <a href="#" id="signInLink" style="color:var(--tangerine);font-weight:600">Sign in</a>`;
    document.getElementById("signInLink")?.addEventListener("click", (e) => { e.preventDefault(); openAuthPage(); });
    shareBtn.disabled = false;
    return;
  }
  const { data: creditResult, error: creditErr } = await supabaseRpc("use_credit", { p_user_id: session.user.id }, session.access_token);
  if (creditErr || !creditResult?.ok) {
    $("shareInfo").innerHTML = `No letters left. <a href="#" id="buyLink" style="color:var(--tangerine);font-weight:600">Buy more →</a>`;
    document.getElementById("buyLink")?.addEventListener("click", (e) => { e.preventDefault(); openAccountPage(); });
    shareBtn.disabled = false;
    return;
  }

  if (!activeShare.notes.length) {
    $("shareInfo").textContent = "Write at least one note before sending.";
    shareBtn.disabled = false;
    return;
  }
  // STRICT: multi-song shares REQUIRE a playlist URL.
  const trackIds = new Set(activeShare.notes.map((n) => n.track_id));
  const isMulti = trackIds.size > 1;
  const playlistId = parsePlaylistId($("playlistUrl").value);
  if (isMulti && !playlistId) {
    $("shareInfo").textContent = "Add a playlist link to share notes across multiple songs";
    shareBtn.disabled = false;
    return;
  }
  // Sync playlist fields from input one more time
  const v = $("playlistUrl").value.trim();
  activeShare.playlist_url = v || null;
  activeShare.playlist_id = parsePlaylistId(v);
  activeShare.type = deriveType(activeShare);
  // Drop malformed notes, then deduplicate by content signature.
  activeShare.notes = sanitizeNotes(activeShare.notes);
  const seen = new Set();
  activeShare.notes = activeShare.notes.filter((n) => {
    const key = `${n.track_id}|${n.timestamp ?? ""}|${n.note}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Always mint a fresh share ID on every send.
  // This sidesteps Supabase RLS blocking DELETEs — old rows are simply
  // orphaned (unreachable), and the new link is a clean slate.
  const { store } = await loadStore();
  const oldId = activeShare.id;
  const newId = shortId();

  // Migrate local share object to new ID.
  activeShare.id = newId;
  activeShare.mode = "inactive";
  delete store.shares[oldId];
  store.shares[newId] = activeShare;
  store.active = newId;

  // Push fresh rows under the new ID.
  for (const note of activeShare.notes) {
    await pushNote(activeShare, note);
  }
  await pushShareMeta(activeShare);

  await saveStore(store);
  shareBtn.disabled = false;
  setMode("inactive");
  notifyContentRefresh();

  const url = shareUrl(activeShare.id);
  try {
    await navigator.clipboard.writeText(url);
    $("shareInfo").innerHTML = `Copied! Send this to a friend:<br/><a href="${url}" target="_blank">${url}</a>`;
  } catch {
    $("shareInfo").innerHTML = `Share link: <a href="${url}" target="_blank">${url}</a>`;
  }
});

$("resetShare").addEventListener("click", async () => {
  if (!confirm("Start a new share? Your current letter will be moved to ‘previous experiences’.")) return;
  const { store } = await loadStore();
  await archiveActive(store);
  store.active = null;
  ensureActive(store, senderName);
  activeShare = store.shares[store.active];
  await saveStore(store);
  $("shareInfo").textContent = "";
  $("playlistUrl").value = "";
  $("recipientName").value = "";
  setMode("editing");
  renderNotes();
  renderSummary();
  renderPrevious();
  notifyContentRefresh();
});

$("importBtn").addEventListener("click", async () => {
  let v = $("importId").value.trim();
  if (!v) return;
  // Accept: raw ID, /share/ID path, or ?id=ID query param
  const mPath = v.match(/\/share\/([a-z0-9_-]+)/i);
  const mQuery = v.match(/[?&]id=([a-z0-9_-]+)/i);
  if (mPath) v = mPath[1];
  else if (mQuery) v = mQuery[1];
  $("importStatus").textContent = "Fetching…";

  const { store } = await loadStore();
  // Same id as active = no-op
  if (store.active === v) {
    $("importStatus").textContent = "This letter is already active.";
    return;
  }
  // Already known? Just reactivate.
  if (store.shares[v]) {
    await activateShare(v);
    $("importStatus").textContent = "Reactivated.";
    return;
  }

  const [meta, remote] = await Promise.all([fetchShareMeta(v), fetchShareNotes(v)]);
  if (!remote.length && !meta) {
    $("importStatus").textContent = "No notes found for that link.";
    return;
  }

  // Archive whatever is currently active before installing the new one
  await archiveActive(store);

  const newShare = {
    id: v,
    mode: "editing", // receiver experiences popups
    type: meta?.share_type || (new Set(remote.map((r) => r.track_id)).size > 1 ? "multi" : "single"),
    playlist_id: meta?.playlist_id || remote.find((r) => r.playlist_id)?.playlist_id || null,
    playlist_url: meta?.playlist_url || null,
    sender_name: meta?.sender_name || remote[0]?.sender_name || "someone",
    imported: true,
    created_at: Date.now(),
    notes: sanitizeNotes(remote.map((r) => ({
      id: r.id,
      track_id: r.track_id,
      track_title: r.track_title,
      track_artist: r.track_artist,
      note: r.note,
      timestamp: r.timestamp,
      sender_name: r.sender_name,
      created_at: new Date(r.created_at).getTime(),
    }))),
  };
  store.shares[v] = newShare;
  store.active = v;
  store.previous = (store.previous || []).filter((x) => x !== v);
  await saveStore(store);
  activeShare = newShare;
  setMode("editing");
  $("importStatus").textContent = `Imported ${remote.length} note${remote.length === 1 ? "" : "s"}.`;
  renderNotes();
  renderSummary();
  renderPrevious();
  notifyContentRefresh();
});

init();
