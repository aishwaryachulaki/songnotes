const $ = (id) => document.getElementById(id);
const { SUPABASE_URL, SUPABASE_KEY, SHARE_ORIGIN: CONFIGURED_ORIGIN } = window.KS_CONFIG;

// ---------- auth ----------
let _session = null;       // cached session from chrome.storage
let _sessionExpired = false; // true when a session existed but the refresh token died

async function getSession() {
  if (_session && _session.expires_at > Date.now() / 1000 + 30) return _session;
  const data = await chrome.storage.local.get("ks_session");
  if (!data.ks_session) return null;
  const s = data.ks_session;
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
        await chrome.storage.local.set({ ks_session: updated });
        _session = updated;
        return updated;
      }
    } catch {}
    // Refresh failed — session is dead
    await chrome.storage.local.remove("ks_session");
    _sessionExpired = true;
    return null;
  }
  _session = s;
  return s;
}

// chrome.storage.local is shared across ALL accounts on this browser, so a new
// sign-in would otherwise see the previous account's letters, vault (cross-device
// relive) state, and saved name. We stamp the local data with its owning user id
// (ks_owner) and, when a DIFFERENT user signs in, wipe the account-scoped keys.
// We only wipe on an actual account CHANGE — never on same-account sign-out/in —
// because received letters keep their decrypted notes only in local storage and
// must survive a re-login. Returns true if a wipe happened.
async function enforceAccountScope(session) {
  const uid = session && session.user && session.user.id;
  if (!uid) return false;
  const { ks_owner } = await chrome.storage.local.get("ks_owner");
  let wiped = false;
  if (ks_owner && ks_owner !== uid) {
    await chrome.storage.local.remove([
      "ks_shares", "ks_vault", "ks_sender", "ks_tutorial", "ks_onboarding",
    ]);
    wiped = true;
  }
  if (ks_owner !== uid) {
    await chrome.storage.local.set({ ks_owner: uid });
  }
  return wiped;
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
  return rows[0] || { paid_credits: 0, lifetime: false, free_credits_used: 0 };
}

function freeCreditsRemaining(c) {
  if (!c) return 0;
  return Math.max(0, 3 - (c.free_credits_used || 0));
}

function creditsLabel(c) {
  if (!c) return "0 letters";
  if (c.lifetime) return "∞ Lifetime";
  const total = c.paid_credits + freeCreditsRemaining(c);
  return `${total} letter${total !== 1 ? "s" : ""}`;
}

function openAuthPage() {
  const url = `https://dropakeepsake.com/auth.html`;
  chrome.tabs.create({ url });
}

function openAccountPage() {
  const url = `https://dropakeepsake.com/notes.html#sent`;
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
// AES-GCM ciphertext is long base64 with no spaces — real names are short and readable.
// Used to avoid storing/displaying raw ciphertext when a decryption key isn't available.
function looksEncrypted(s) {
  return typeof s === "string" && s.length > 30 && !/\s/.test(s) &&
    /[+\/=]/.test(s) && /^[A-Za-z0-9+\/=]+$/.test(s);
}
// Returns only structurally valid notes — guards share/import paths.
function sanitizeNotes(notes) {
  return (notes || []).filter((n) => n && n.id && n.note && n.track_id);
}

// ---------- end-to-end encryption ----------
// AES-256-GCM via Web Crypto. The key never leaves the client —
// it lives only in the share link URL fragment (#k=...) which
// browsers never send to any server.

async function generateEncKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}
async function exportEncKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}
async function importEncKey(b64) {
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}
async function encryptField(text, key) {
  if (text == null) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(String(text))
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...out));
}
async function decryptField(b64, key) {
  if (b64 == null) return null;
  try {
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dec = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf.slice(0, 12) },
      key,
      buf.slice(12)
    );
    return new TextDecoder().decode(dec);
  } catch {
    return b64; // old plaintext share — return as-is
  }
}
async function encryptNoteFields(note, key) {
  return {
    ...note,
    // Only the note text is personal — track/artist/sender are metadata.
    note: await encryptField(note.note, key),
  };
}
async function decryptNoteFields(note, key) {
  return {
    ...note,
    note: await decryptField(note.note, key),
  };
}

function parsePlaylistId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/playlist\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9]{10,40}$/.test(s)) return s;
  return null;
}

// ---------- vault: zero-knowledge cross-device key recovery (opt-in) ----------
// A passphrase derives a master key (PBKDF2) that never leaves the device. Each
// per-share key is stored on the server WRAPPED with the master key, so the
// server only ever holds wrapped blobs + a salt. On a new device, the passphrase
// re-derives the master key and unwraps the keys into local storage.
const VAULT_VERIFIER = "keepsake-vault-v1";

// Strict AES-GCM decrypt that THROWS on failure (unlike decryptField which
// returns the input). Used for the verifier + unwrapping, where we must detect
// a wrong passphrase.
async function decryptStrict(b64, key) {
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
  return new TextDecoder().decode(dec);
}
async function deriveVaultMasterKey(passphrase, saltB64, iterations) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}
async function exportMasterKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}
async function importMasterKey(b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

async function loadVaultState() {
  const data = await chrome.storage.local.get("ks_vault");
  return data.ks_vault || { user_id: null, enabled: false, masterKeyB64: null };
}
async function saveVaultState(v) {
  await chrome.storage.local.set({ ks_vault: v });
}
// In-memory master key for the current session (imported from the cached b64).
async function getVaultMasterKey() {
  const v = await loadVaultState();
  if (!v.enabled || !v.masterKeyB64) return null;
  try { return await importMasterKey(v.masterKeyB64); } catch { return null; }
}

// --- vault REST (owner-scoped via RLS) ---
async function fetchVaultMeta(accessToken, userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_vault?user_id=eq.${encodeURIComponent(userId)}&select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}
async function putVaultMeta(row, accessToken) {
  return fetch(`${SUPABASE_URL}/rest/v1/user_vault`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
}
async function upsertVaultKeys(rows, accessToken) {
  if (!rows || !rows.length) return;
  return fetch(`${SUPABASE_URL}/rest/v1/vault_keys`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
}
async function fetchVaultKeys(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/vault_keys?select=share_id,wrapped_key`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return [];
  return res.json();
}
// The set of share ids this account legitimately owns or has received — used to
// avoid wrapping keys that belong to a different account on the same device.
async function fetchOwnedOrReceivedShareIds(accessToken, userId) {
  const ids = new Set();
  const hdrs = { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}` };
  try {
    const r1 = await fetch(`${SUPABASE_URL}/rest/v1/shares?user_id=eq.${encodeURIComponent(userId)}&select=id`, { headers: hdrs });
    if (r1.ok) (await r1.json()).forEach((r) => ids.add(r.id));
  } catch {}
  try {
    const r2 = await fetch(`${SUPABASE_URL}/rest/v1/received_shares?user_id=eq.${encodeURIComponent(userId)}&select=share_id`, { headers: hdrs });
    if (r2.ok) (await r2.json()).forEach((r) => ids.add(r.share_id));
  } catch {}
  return ids;
}

// Set up (or re-set) the vault from THIS device, wrapping every local key.
async function vaultSetup(passphrase) {
  const session = await getSession();
  if (!session) throw new Error("not signed in");
  const saltB64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const iterations = 600000;
  const masterKey = await deriveVaultMasterKey(passphrase, saltB64, iterations);
  const verifier = await encryptField(VAULT_VERIFIER, masterKey);
  await putVaultMeta(
    { user_id: session.user.id, salt: saltB64, iterations, verifier, updated_at: new Date().toISOString() },
    session.access_token
  );
  // Only wrap keys for letters this account actually owns or has received —
  // never keys left in local storage from a different account on this device.
  const allowed = await fetchOwnedOrReceivedShareIds(session.access_token, session.user.id);
  const { store } = await loadStore();
  const rows = [];
  for (const s of Object.values(store.shares || {})) {
    if (s && s.id && s.enc_key && allowed.has(s.id)) {
      rows.push({ user_id: session.user.id, share_id: s.id, wrapped_key: await encryptField(s.enc_key, masterKey) });
    }
  }
  await upsertVaultKeys(rows, session.access_token);
  await saveVaultState({ user_id: session.user.id, enabled: true, masterKeyB64: await exportMasterKey(masterKey) });
}

// Unlock on this device: verify passphrase, then unwrap all keys into local store.
async function vaultUnlock(passphrase) {
  const session = await getSession();
  if (!session) throw new Error("not signed in");
  const meta = await fetchVaultMeta(session.access_token, session.user.id);
  if (!meta) throw new Error("no vault");
  const masterKey = await deriveVaultMasterKey(passphrase, meta.salt, meta.iterations);
  let ok = false;
  try { ok = (await decryptStrict(meta.verifier, masterKey)) === VAULT_VERIFIER; } catch { ok = false; }
  if (!ok) throw new Error("wrong passphrase");
  // Unwrap every key into a share_id -> rawKey map.
  const wrapped = await fetchVaultKeys(session.access_token);
  const keyMap = {};
  for (const row of wrapped) {
    try { keyMap[row.share_id] = await decryptStrict(row.wrapped_key, masterKey); } catch {}
  }
  const { store } = await loadStore();
  // Pull metadata for the user's own letters so they show up in "Previous
  // Experiences" on this device (recipient name, note/song counts, date).
  let metaShares = [];
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/shares?user_id=eq.${encodeURIComponent(session.user.id)}` +
      `&select=id,share_type,playlist_id,playlist_url,playlist_name,sender_name,recipient_name,description,created_at,annotations(track_id)` +
      `&order=created_at.desc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${session.access_token}` } }
    );
    if (r.ok) metaShares = await r.json();
  } catch {}
  const prevIds = [];
  for (const m of metaShares) {
    const key = keyMap[m.id];
    if (!key) continue; // only letters we can actually decrypt
    const anns = Array.isArray(m.annotations) ? m.annotations : [];
    store.shares[m.id] = {
      id: m.id,
      enc_key: key,
      mode: "inactive",
      type: m.share_type || "single",
      playlist_id: m.playlist_id || null,
      playlist_url: m.playlist_url || null,
      playlist_name: m.playlist_name || null,
      sender_name: m.sender_name || senderName || "someone",
      recipient_name: (m.recipient_name && !looksEncrypted(m.recipient_name)) ? m.recipient_name : null,
      description: m.description ? (looksEncrypted(m.description) ? (await decryptField(m.description, key)) : m.description) : null,
      note_count: anns.length,
      song_count: new Set(anns.map((a) => a.track_id).filter(Boolean)).size,
      created_at: m.created_at ? new Date(m.created_at).getTime() : Date.now(),
      notes: [],
    };
    prevIds.push(m.id);
  }
  // Keep keys for any other letters (e.g. received) as stubs so website relive works.
  for (const sid in keyMap) {
    if (!store.shares[sid]) store.shares[sid] = { id: sid, enc_key: keyMap[sid] };
    else if (!store.shares[sid].enc_key) store.shares[sid].enc_key = keyMap[sid];
  }
  store.previous = [...prevIds, ...(store.previous || []).filter((id) => !prevIds.includes(id))];

  // Backfill: wrap any key that's present locally (owned/received) but NOT yet
  // in the vault, so a future storage-clear can't strip a key that was present
  // on an unlocked device at least once. (Can't recover already-lost keys.)
  try {
    const allowed = await fetchOwnedOrReceivedShareIds(session.access_token, session.user.id);
    const backfill = [];
    for (const s of Object.values(store.shares || {})) {
      if (s && s.id && s.enc_key && allowed.has(s.id) && !(s.id in keyMap)) {
        backfill.push({ user_id: session.user.id, share_id: s.id, wrapped_key: await encryptField(s.enc_key, masterKey) });
      }
    }
    if (backfill.length) await upsertVaultKeys(backfill, session.access_token);
  } catch (e) { console.warn("Keepsake: vault backfill on unlock failed", e); }

  await saveStore(store);
  await saveVaultState({ user_id: session.user.id, enabled: true, masterKeyB64: await exportMasterKey(masterKey) });
}

// ---------- share-scoped storage model ----------
// ks_shares = {
//   active: "<id>",
//   shares: {
//     [id]: { id, mode: "editing"|"inactive",
//             type: "single"|"multi"|"playlist",
//             playlist_id, playlist_url,
//             sender_name, recipient_name,
//             enc_key: string|null,    // base64 AES-256-GCM key; present on sent shares
//             note_count: number,      // saved at archive time (notes array is stripped when enc_key set)
//             song_count: number,      // saved at archive time
//             notes: [{id, track_id, track_title, track_artist, note, timestamp, sender_name, created_at}],
//             imported: bool, created_at }
//   },
//   previous: ["<id>", ...]   // archived share IDs (most recent first)
// }
async function loadStore() {
  const data = await chrome.storage.local.get(["ks_shares", "ks_sender"]);
  const store = data.ks_shares || { active: null, shares: {}, previous: [] };
  return { store, sender: data.ks_sender || "" };
}
async function saveStore(store) {
  try {
    await chrome.storage.local.set({ ks_shares: store });
  } catch (err) {
    console.error("Keepsake: storage write failed:", err);
    throw new Error("storage_full");
  }
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
      playlist_name: null,
      thumbnail_url: null,
      sender_name: sender || "someone",
      recipient_name: null,
      description: null,
      notes: [],
      imported: false,
      created_at: Date.now(),
    };
    store.active = id;
  }
  return store.shares[store.active];
}
// A share with no real user content — used to detect throwaway "ghost" cards.
function isBlankShare(share) {
  return !!share && !share.enc_key && !(share.notes && share.notes.length)
    && !share.recipient_name && !share.description;
}
function makeBlankShare(sender, extra = {}) {
  return {
    id: shortId(), mode: "editing", type: "single",
    playlist_id: null, playlist_url: null, playlist_name: null, thumbnail_url: null,
    sender_name: sender || "someone", recipient_name: null, description: null,
    notes: [], imported: false, created_at: Date.now(), ...extra,
  };
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
let trackThumbUrl = null;  // cached thumbnail for the current single track
let trackThumbId  = null;  // trackId the above corresponds to

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}
async function fetchTrack() {
  const tab = await getActiveTab();
  // Not on Spotify at all — signal clearly so the popup can say the right thing
  if (!tab || !tab.url || !tab.url.includes("open.spotify.com")) {
    return { trackId: null, playerVisible: false, notOnSpotify: true };
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "KS_GET_STATE" });
  } catch {
    // Content script not injected yet (page still loading) — treat as undetectable
    return { trackId: null, playerVisible: false, notOnSpotify: false };
  }
}
async function notifyContentRefresh() {
  const tab = await getActiveTab();
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "KS_REFRESH" }).catch(() => {});
}

// ---------- backend ----------
async function pushShareMeta(share, accessToken, userId) {
  const token = accessToken || SUPABASE_KEY;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/shares`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        id: share.id,
        user_id: userId || null,
        share_type: share.type,
        playlist_id: share.playlist_id,
        playlist_url: share.playlist_url,
        playlist_name: share.playlist_name || null,
        sender_name: share.sender_name || senderName || "someone",
        recipient_name: share.recipient_name || null,
        description: share.description || null,
        sender_content: share.sender_content || null,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.status);
      console.error("Keepsake: pushShareMeta failed", res.status, errText);
      return { ok: false, error: `${res.status}: ${errText}` };
    }
    return { ok: true, error: null };
  } catch (e) {
    console.error("Keepsake: pushShareMeta exception", e);
    return { ok: false, error: e.message };
  }
}
async function pushNote(share, note, accessToken) {
  const token = accessToken || SUPABASE_KEY;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/annotations`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
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
async function deleteNoteRemote(id, accessToken) {
  // Works for imported notes (id === Supabase row id).
  // For locally-created notes the id won't match any row — silently no-ops.
  // Requires the user's access token so Supabase RLS can verify ownership.
  if (!accessToken) return;
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/annotations?id=eq.${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
  } catch {}
}

// Reads go through the get_share() RPC: it returns ONE letter by its id and
// bypasses RLS safely, so direct table reads can stay locked to owners/recipients.
async function fetchShareBundle(id) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/get_share?p_share_id=${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) return { meta: null, notes: [] };
  const b = await res.json().catch(() => null);
  return { meta: b && b.meta ? b.meta : null, notes: b && Array.isArray(b.notes) ? b.notes : [] };
}
async function fetchShareNotes(id) { return (await fetchShareBundle(id)).notes; }
async function fetchShareMeta(id)  { return (await fetchShareBundle(id)).meta; }

function shareUrl(id) {
  if (!shareOrigin) return id; // no host yet — just show the ID
  return `${shareOrigin}/share.html?id=${id}`;
}

// ---------- rendering ----------
function setMode(_mode) {
  // Mode banner was removed from the UI. Call sites are kept as documentation
  // of intent ("editing" = popups on, "inactive" = popups off) and may be
  // wired to UI elements again in a future redesign.
}

async function renderNotes() {
  const list = $("notes");
  if (!currentTrack || !activeShare) {
    list.innerHTML = '<div class="empty">No song detected.</div>';
    renderSongIndex();
    return;
  }
  const notes = activeShare.notes.filter((n) => n.track_id === currentTrack.trackId);
  if (!notes.length) {
    list.innerHTML = '<div class="empty">No notes on this song yet.</div>';
    renderSongIndex();
    return;
  }
  list.innerHTML = "";
  notes.slice().sort((a, b) => (a.timestamp ?? -1) - (b.timestamp ?? -1)).forEach((n) => {
    const div = document.createElement("div");
    const isExperience = activeShare?.mode === "experience";
    div.className = "note" + (isExperience ? " note--readonly" : "");
    div.dataset.noteId = n.id;
    div.innerHTML = `
      <div class="meta">${formatTs(n.timestamp)}</div>
      <div class="note-text">${escapeHtml(n.note)}</div>
      ${isExperience ? "" : `
      <div class="note-actions">
        <button class="del" data-id="${n.id}" title="Delete">×</button>
        <button class="note-edit" data-id="${n.id}" title="Edit">✎</button>
      </div>`}`;
    list.appendChild(div);
  });

  list.querySelectorAll(".note-edit").forEach((b) =>
    b.addEventListener("click", (e) => {
      const noteId = e.currentTarget.dataset.id;
      const n = activeShare.notes.find((x) => x.id === noteId);
      if (!n) return;
      const noteDiv = list.querySelector(`.note[data-note-id="${noteId}"]`);
      if (!noteDiv) return;
      noteDiv.classList.add("note--editing");
      noteDiv.innerHTML = `
        <textarea class="note-edit-textarea" maxlength="260">${escapeHtml(n.note)}</textarea>
        <input class="note-edit-ts" type="text" value="${n.timestamp != null ? escapeHtml(formatTs(n.timestamp)) : ""}" placeholder="Timestamp (e.g. 1:24), optional" />
        <div class="note-edit-actions">
          <button class="note-save-edit" data-id="${noteId}">Save</button>
          <button class="note-cancel-edit">Cancel</button>
        </div>`;
      noteDiv.querySelector(".note-edit-textarea").focus();

      noteDiv.querySelector(".note-save-edit").addEventListener("click", async () => {
        const newText = noteDiv.querySelector(".note-edit-textarea").value.trim();
        if (!newText) return;
        const newTs = parseTimestamp(noteDiv.querySelector(".note-edit-ts").value);
        const { store } = await loadStore();
        for (const shareId in store.shares) {
          const match = store.shares[shareId].notes.find((x) => x.id === noteId);
          if (match) { match.note = newText; match.timestamp = newTs; }
        }
        try {
          await saveStore(store);
        } catch {
          $("status").textContent = "Couldn't save. Storage is full.";
          return;
        }
        activeShare.notes = store.shares[activeShare.id]?.notes ?? [];
        renderNotes();
        renderSharePanel().catch(console.error);
        notifyContentRefresh();
      });

      noteDiv.querySelector(".note-cancel-edit").addEventListener("click", () => renderNotes());
    }),
  );

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
      try {
        await saveStore(store);
      } catch {
        $("status").textContent = "Couldn't save. Storage is full.";
        return;
      }
      // Keep the module-level reference consistent with the saved store.
      activeShare.notes = store.shares[activeShare.id]?.notes ?? [];
      // Best-effort remote delete (works when id is a Supabase row id).
      // Fire-and-forget — local delete already happened above.
      getSession().then(s => deleteNoteRemote(deletedId, s?.access_token));
      renderNotes();
      renderSharePanel().catch(console.error);
      notifyContentRefresh();
    }),
  );

  renderSongIndex();
}

function renderSongIndex() {
  const header = $("songIndexHeader");
  const container = $("songIndex");
  if (!container) return;

  if (!activeShare || !activeShare.notes.length) {
    if (header) header.style.display = "none";
    container.innerHTML = "";
    return;
  }

  // Group notes by track_id, preserving insertion order (first seen = listed first)
  const trackMap = new Map();
  for (const n of activeShare.notes) {
    if (!n.track_id) continue;
    if (!trackMap.has(n.track_id)) {
      trackMap.set(n.track_id, { title: n.track_title || "Unknown track", artist: n.track_artist || "", count: 0 });
    }
    trackMap.get(n.track_id).count++;
  }

  if (!trackMap.size) {
    if (header) header.style.display = "none";
    container.innerHTML = "";
    return;
  }

  if (header) header.style.display = "";
  container.innerHTML = "";

  for (const [trackId, info] of trackMap) {
    const isPlaying = currentTrack?.trackId === trackId;
    const row = document.createElement("div");
    row.className = "song-row" + (isPlaying ? " song-row--active" : "");
    row.innerHTML = `
      <div class="song-row-info">
        <div class="song-row-title">${escapeHtml(info.title)}</div>
        ${info.artist ? `<div class="song-row-artist">${escapeHtml(info.artist)}</div>` : ""}
      </div>
      <div class="song-row-count">${info.count} note${info.count !== 1 ? "s" : ""}</div>
      ${isPlaying ? '<div class="song-row-playing">✧</div>' : ""}`;
    container.appendChild(row);
  }
}

async function attachPlaylist() {
  const v = $("playlistUrl")?.value.trim() || "";
  activeShare.playlist_url = v || null;
  activeShare.playlist_id  = parsePlaylistId(v);
  activeShare.type = deriveType(activeShare);
  activeShare.thumbnail_url = null;

  if (v && activeShare.playlist_id) {
    try {
      const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(v)}`);
      if (r.ok) {
        const d = await r.json();
        activeShare.playlist_name = d.title || "A Playlist Share";
        activeShare.thumbnail_url = d.thumbnail_url || null;
      } else {
        activeShare.playlist_name = "A Playlist Share";
      }
    } catch {
      activeShare.playlist_name = "A Playlist Share";
    }
  } else {
    activeShare.playlist_name = null;
  }

  const { store } = await loadStore();
  store.shares[activeShare.id] = activeShare;
  await saveStore(store).catch(console.error);
  renderSharePanel().catch(console.error);
}

async function renderSharePanel() {
  if (!activeShare) return;

  const notes     = activeShare.notes || [];
  const noteCount = notes.length;
  const uniqueIds = new Set(notes.map((n) => n.track_id).filter(Boolean));
  const songCount = uniqueIds.size;
  const isMulti   = songCount > 1;
  const hasPlaylist = !!activeShare.playlist_id;

  // state: 'single' | 'needsPlaylist' | 'playlist'
  const state = isMulti ? (hasPlaylist ? "playlist" : "needsPlaylist") : "single";
  const isExperience = activeShare?.mode === "experience";
  const isEditingOldShare = activeShare?.mode === "editing" && !!activeShare?.enc_key;

  // ── Header ──
  const recipientEl = $("spRecipient");
  if (recipientEl) recipientEl.textContent = activeShare.recipient_name || "someone";

  const pillEl = $("spPill");
  if (pillEl) {
    if (isExperience) {
      pillEl.textContent = "● Already sent";
      pillEl.className = "sp-pill sp-pill--ready";
    } else if (state === "needsPlaylist") {
      pillEl.textContent = "● Playlist needed";
      pillEl.className = "sp-pill sp-pill--needed";
    } else if (state === "playlist") {
      pillEl.textContent = "● Playlist ready";
      pillEl.className = "sp-pill sp-pill--ready";
    } else {
      pillEl.textContent = "● Ready to share";
      pillEl.className = "sp-pill sp-pill--ready";
    }
  }

  // ── Re-share heads-up note ──
  const reshareNote = $("spReshareNote");
  if (reshareNote) reshareNote.classList.toggle("hidden", !isEditingOldShare);

  // ── Show / hide sections ──
  const cardEl  = $("spCard");
  const inputEl = $("spInputSection");

  if (state === "needsPlaylist") {
    cardEl?.classList.add("hidden");
    inputEl?.classList.remove("hidden");
  } else {
    cardEl?.classList.remove("hidden");
    inputEl?.classList.add("hidden");

    // ── Populate card ──
    let thumbUrl = null;
    let cardTitle = "";
    let cardSub   = "";

    if (state === "single") {
      cardTitle = currentTrack?.title || "No song playing";
      cardSub   = noteCount
        ? `${noteCount} note${noteCount !== 1 ? "s" : ""}`
        : "Play a song and write notes above";

      // Fetch thumbnail for the current track (cached by trackId)
      if (currentTrack?.trackId && !currentTrack.trackId.startsWith("local:")) {
        if (currentTrack.trackId !== trackThumbId) {
          try {
            const trackUrl = `https://open.spotify.com/track/${currentTrack.trackId}`;
            const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`);
            if (r.ok) {
              const d = await r.json();
              trackThumbUrl = d.thumbnail_url || null;
              trackThumbId  = currentTrack.trackId;
            }
          } catch { /* no thumbnail — show none */ }
        }
        thumbUrl = trackThumbUrl;
      }
    } else {
      cardTitle = activeShare.playlist_name || "A Playlist Share";
      cardSub   = `${noteCount} note${noteCount !== 1 ? "s" : ""} across ${songCount} song${songCount !== 1 ? "s" : ""}`;
      thumbUrl  = activeShare.thumbnail_url || null;
    }

    const thumbEl = $("spThumb");
    if (thumbEl) {
      if (thumbUrl) {
        thumbEl.src = thumbUrl;
        thumbEl.style.display = "";
      } else {
        thumbEl.src = "";
        thumbEl.style.display = "none";
      }
    }
    const titleEl = $("spCardTitle");
    if (titleEl) titleEl.textContent = cardTitle;
    const subEl = $("spCardSub");
    if (subEl) subEl.textContent = cardSub;

    // ── Make the card clickable to open the playlist / track in Spotify ──
    // Works in both experience and edit modes; falls back to the track URL
    // from notes if the user isn't currently on Spotify.
    const openUrl = hasPlaylist
      ? (activeShare.playlist_url || null)
      : (() => {
          const tid = currentTrack?.trackId || activeShare.notes?.[0]?.track_id;
          return tid ? `https://open.spotify.com/track/${tid}` : null;
        })();
    if (cardEl) {
      cardEl.onclick = openUrl ? () => chrome.tabs.create({ url: openUrl }) : null;
      cardEl.classList.toggle("sp-card--clickable", !!openUrl);
    }
  }

  // ── Share button ──
  const shareBtn = $("copyShare");
  if (shareBtn) {
    if (isExperience) {
      shareBtn.textContent = "COPY LINK";
      shareBtn.disabled = false;
    } else {
      shareBtn.textContent = "SHARE";
      shareBtn.disabled = state === "needsPlaylist";
    }
  }
}

async function renderPrevious() {
  const session = await getSession();
  const list = $("previousList");
  const header = $("prevHeader");

  // Never show previous shares when logged out
  if (!session) {
    list.innerHTML = "";
    if (header) header.style.display = "none";
    return;
  }

  const { store } = await loadStore();
  const allPrev = (store.previous || []).filter((id) => store.shares[id]);
  const prev = allPrev.slice(0, 3);

  if (!prev.length) {
    list.innerHTML = "";
    if (header) header.style.display = "none";
    return;
  }

  if (header) header.style.display = "";
  list.innerHTML = "";

  prev.forEach((id) => {
    const s = store.shares[id];
    // Notes may have been stripped after archiving — fall back to saved counts.
    const noteCount = s.notes.length || s.note_count || 0;
    const songCount = s.notes.length
      ? new Set(s.notes.map((n) => n.track_id)).size
      : (s.song_count || 0);
    const title = s.recipient_name
      ? `Notes for ${s.recipient_name}`
      : "Notes (unknown recipient)";
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
      <img class="prev-thumb" src="prev-thumb.png" alt="" />
      <div class="prev-meta">
        <div class="prev-title">${escapeHtml(title)}</div>
        <div class="prev-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="prev-actions">
        ${s.enc_key ? `<button class="prev-copy" data-id="${id}" title="Copy share link">Copy link</button>` : ""}
        <button class="prev-activate" data-id="${id}">Relive</button>
      </div>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll(".prev-copy").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const sid = e.currentTarget.dataset.id;
      const { store: s } = await loadStore();
      const share = s.shares[sid];
      if (!share?.enc_key) return;
      const url = `${shareUrl(share.id)}&e=1#k=${encodeURIComponent(share.enc_key)}`;
      try {
        await navigator.clipboard.writeText(url);
        e.currentTarget.textContent = "Copied!";
        setTimeout(() => { e.currentTarget.textContent = "Copy link"; }, 2000);
      } catch {
        e.currentTarget.textContent = "Copy link";
      }
    }),
  );

  list.querySelectorAll(".prev-activate").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Loading…";
      await reliveShare(btn.dataset.id);
      btn.disabled = false;
      btn.textContent = "Relive";
    }),
  );

  if (allPrev.length > 3) {
    const more = document.createElement("div");
    more.className = "prev-more";
    more.textContent = "View more on your account →";
    more.addEventListener("click", openAccountPage);
    list.appendChild(more);
  }
}

function showComposer(show) {
  // In experience mode the composer is always hidden — the banner owns that slot.
  if (activeShare?.mode === "experience") return;
  $("composer").classList.toggle("hidden", !show);
  $("nameBlock").classList.toggle("hidden", show);
  if (show) $("whoami").textContent = senderName;
}

function renderExperienceBanner() {
  const banner = $("experienceBanner");
  if (!banner) return;
  const isExperience = activeShare?.mode === "experience";
  banner.classList.toggle("hidden", !isExperience);
  if (isExperience) {
    // Keep composer and name block out of the way.
    $("composer")?.classList.add("hidden");
    $("nameBlock")?.classList.add("hidden");
    const who = activeShare.recipient_name
      ? `Notes for ${activeShare.recipient_name}`
      : "Notes (no recipient set)";
    const dateStr = activeShare.created_at
      ? new Date(activeShare.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : null;
    const expWho = $("expWho");
    if (expWho) expWho.textContent = dateStr ? `${who} · sent ${dateStr}` : who;
  } else {
    // Restore normal composer visibility.
    showComposer(!!senderName);
  }
}

// ---------- share lifecycle ----------
async function archiveActive(store) {
  if (!store.active) return;
  const share = store.shares[store.active];
  if (!share) return;
  // Trial shares (tutorial practice) are never saved — discard outright.
  if (share.is_trial) {
    delete store.shares[store.active];
    return;
  }
  // Blank unsent shares (no notes, no recipient, never sent) are ghost cards —
  // silently delete rather than push into Previous Experiences.
  const isBlank = !share.enc_key && !share.notes?.length && !share.recipient_name;
  if (isBlank) {
    delete store.shares[store.active];
    return;
  }
  if (share.enc_key) {
    // Share was sent — notes live in Supabase, no need to keep them locally.
    // Save counts first so renderPrevious can still show "3 notes · 2 songs".
    share.note_count = share.notes.length;
    share.song_count = new Set(share.notes.map((n) => n.track_id)).size;
    share.notes = [];
  }
  store.previous = [store.active, ...(store.previous || []).filter((x) => x !== store.active)];
}
async function reliveShare(id) {
  const { store } = await loadStore();
  if (!store.shares[id]) return;

  const share = store.shares[id];

  // Notes were stripped on archive — fetch + decrypt from Supabase before activating.
  if (share.enc_key && !share.notes?.length) {
    try {
      const [, remote] = await Promise.all([fetchShareMeta(id), fetchShareNotes(id)]);
      if (remote.length) {
        const importKey = await importEncKey(share.enc_key);
        share.notes = await Promise.all(remote.map((n) => decryptNoteFields(n, importKey)));
        store.shares[id] = share;
      }
    } catch {
      // Supabase unreachable — activate anyway with empty notes rather than blocking.
      // User will see "No notes on this song" in the overlay but can retry later.
      console.warn("Keepsake: could not fetch notes for reactivated share", id);
    }
  }

  if (store.active && store.active !== id) {
    // Save the displaced share's ID so + New Share can restore it rather than
    // creating a blank. Only worth saving if it has real content (notes or a
    // recipient) and hasn't already been sent (no enc_key).
    const displaced = store.shares[store.active];
    const isWorthRestoring = displaced && !displaced.enc_key &&
      (displaced.notes?.length > 0 || !!displaced.recipient_name);
    store.displacedActive = isWorthRestoring ? store.active : null;
    await archiveActive(store);
  }
  store.previous = (store.previous || []).filter((x) => x !== id);
  store.active = id;
  // Reactivated sent shares open in experience mode (read-only).
  // Unsent shares (no enc_key) open in editing mode as normal.
  share.mode = share.enc_key ? "experience" : "editing";
  share.relived = true; // came from Previous → "+ New Share" returns it there
  store.shares[id] = share;
  await saveStore(store).catch(console.error);
  activeShare = store.shares[id];
  $("recipientName").value = activeShare.recipient_name || "";
  if ($("shareDescription")) $("shareDescription").value = activeShare.description || "";
  renderExperienceBanner();
  renderNotes();
  renderSharePanel().catch(console.error);
  renderPrevious();
  notifyContentRefresh();
}

async function init() {
  // Before reading any local data, make sure it belongs to the signed-in
  // account — wipe it if a different user is now logged in on this browser.
  const _scopeSession = await getSession();
  if (_scopeSession) await enforceAccountScope(_scopeSession);

  const { store, sender } = await loadStore();
  senderName = sender;
  shareOrigin = CONFIGURED_ORIGIN || "";

  // Migrate old-design installs: the tutorial used to live as a share in
  // ks_shares ("ks-tutorial"). Remove it and move the overlay to its own key
  // so the user's active slot is a normal, saveable share.
  if (store.shares && store.shares["ks-tutorial"]) {
    delete store.shares["ks-tutorial"];
    store.previous = (store.previous || []).filter((x) => x !== "ks-tutorial");
    if (store.active === "ks-tutorial") store.active = null;
    const { ks_tutorial } = await chrome.storage.local.get("ks_tutorial");
    if (!ks_tutorial) await chrome.storage.local.set({ ks_tutorial: buildTutorialOverlay(true) });
  }

  // Tutorial overlay: self-heal stale copy + manage the trial sandbox.
  let tutorialActive = false;
  let forceNameCard = false; // one-shot: lead with the name card on first open
  {
    const { ks_tutorial } = await chrome.storage.local.get("ks_tutorial");
    tutorialActive = !!(ks_tutorial && ks_tutorial.active);
    if (tutorialActive && ks_tutorial.version !== TUTORIAL_VERSION) {
      await chrome.storage.local.set({ ks_tutorial: buildTutorialOverlay(true) });
    }
    if (tutorialActive) {
      // Ensure the active slot is a trial sandbox so practice isn't saved.
      const cur = store.active ? store.shares[store.active] : null;
      if (!cur) {
        const trial = makeBlankShare(senderName, { is_trial: true });
        store.shares[trial.id] = trial; store.active = trial.id;
      } else if (!cur.is_trial) {
        if (isBlankShare(cur)) {
          cur.is_trial = true;
        } else {
          store.previous = [store.active, ...(store.previous || []).filter((x) => x !== store.active)];
          const trial = makeBlankShare(senderName, { is_trial: true });
          store.shares[trial.id] = trial; store.active = trial.id;
        }
      }
    } else {
      // Tutorial not active: clean up any leftover practice shares.
      purgeTrialShares(store);
    }
  }

  // Consume the one-shot "lead with the name card" flag (first open / replay only).
  if (tutorialActive) {
    const { ks_tutorial: t } = await chrome.storage.local.get("ks_tutorial");
    if (t && t.nameCardPending) {
      forceNameCard = true;
      await chrome.storage.local.set({ ks_tutorial: { ...t, nameCardPending: false } });
    }
  }

  activeShare = ensureActive(store, senderName);
  await saveStore(store).catch(console.error);

  let state = await fetchTrack();
  // If fetchTrack() couldn't detect the song (tab query unreliable from side
  // panel context), fall back to the track background.js last cached from
  // a KS_TRACK_CHANGED broadcast. This covers the case where the song was
  // already playing before the panel was opened.
  if ((!state || !state.trackId) && !state?.notOnSpotify) {
    const cached = await chrome.runtime.sendMessage({ type: "KS_GET_CACHED_TRACK" }).catch(() => null);
    if (cached && cached.trackId) state = { ...cached, playerVisible: true };
  }
  if (state && state.trackId) {
    currentTrack = state;
    $("trackTitle").textContent = state.title || "Unknown track";
    $("trackArtist").textContent = state.artist || "";
  } else if (state && state.notOnSpotify) {
    // User hasn't opened Spotify yet — expected state
    $("trackTitle").textContent = "No song playing";
    $("trackArtist").textContent = "Open Spotify Web Player to start";
  } else if (state && !state.notOnSpotify && !state.playerVisible) {
    // On Spotify, but the player widget couldn't be found — likely a Spotify update
    $("trackTitle").textContent = "Player not detected";
    $("trackArtist").textContent = "Spotify may have updated. Check for a Keepsake update";
  } else {
    // On Spotify, player found, but no track loaded yet (paused on home screen etc.)
    $("trackTitle").textContent = "Nothing playing";
    $("trackArtist").textContent = "Play a song to get started";
  }

  $("playlistUrl").value = activeShare.playlist_url || "";
  $("recipientName").value = activeShare.recipient_name || "";
  if ($("shareDescription")) $("shareDescription").value = activeShare.description || "";
  setMode(activeShare.mode || "editing");
  renderExperienceBanner();
  // On the first tutorial open / replay, lead with the name card (step 2);
  // afterward, behave normally even while the tutorial is still active.
  showComposer(forceNameCard ? false : !!senderName);
  renderNotes();
  renderSharePanel().catch(console.error);
  renderPrevious();
  renderTutorialUI().catch(console.error);

  // ── Auth UI ──
  await refreshAuthUI();
}

async function renderTutorialUI() {
  const { ks_tutorial } = await chrome.storage.local.get("ks_tutorial");
  const active = !!(ks_tutorial && ks_tutorial.active);
  const banner = $("tutorialBanner");
  const replayBlock = $("replayTutorialBlock");
  if (banner) banner.classList.toggle("hidden", !active);
  if (replayBlock) replayBlock.style.display = active ? "none" : "";
}

// Extracted so it can be called both from init() and from the
// storage-change listener that fires when the user logs in externally.
async function refreshAuthUI() {
  const session = await getSession();
  if (session) {
    $("authGate").classList.add("hidden");
    $("authBar").classList.remove("hidden");
    $("authEmail").textContent = session.user?.email || "";
    // Fetch and show credits
    const c = await fetchCredits(session.access_token, session.user.id);
    const badge = $("creditsBadge");
    badge.textContent = creditsLabel(c);
    if (c && !c.lifetime && c.paid_credits === 0 && freeCreditsRemaining(c) === 0) {
      badge.classList.add("empty");
    } else {
      badge.classList.remove("empty");
    }
    // Vault (cross-device) status
    try {
      const meta = await fetchVaultMeta(session.access_token, session.user.id);
      const vstate = await loadVaultState();
      const unlocked = !!(vstate.masterKeyB64 && vstate.user_id === session.user.id);
      renderVaultUI(!!meta, unlocked);
    } catch { renderVaultUI(false, false); }
  } else {
    $("authGate").classList.remove("hidden");
    $("authBar").classList.add("hidden");
    const vb = $("vaultBlock"); if (vb) vb.style.display = "none";
    if (_sessionExpired) {
      $("authGate").querySelector(".auth-gate-text").textContent =
        "Your session expired. Please sign in again.";
    }
  }
}

// Drives the cross-device vault UI based on whether a vault exists server-side
// and whether it's unlocked on this device.
let _vaultMode = "off"; // 'off' (no vault) | 'unlock' | 'on'
function renderVaultUI(hasVault, unlocked) {
  const block = $("vaultBlock");
  if (!block) return;
  block.style.display = "";
  const summary = $("vaultSummary");
  const body = $("vaultBody");
  const disc = $("vaultDisclaimer");
  const pass2 = $("vaultPass2");
  const btn = $("vaultBtn");
  const change = $("vaultChange");
  const status = $("vaultStatus");
  status.textContent = "";
  $("vaultPass").value = ""; pass2.value = "";
  if (hasVault && unlocked) {
    _vaultMode = "on";
    summary.textContent = "▸ Cross-device relive · On";
    disc.style.display = "none";
    $("vaultRow").style.display = "none";
    pass2.style.display = "none";
    change.style.display = "";
    status.textContent = "On. Your letters relive on any device you sign into. (Sign out to lock this device.)";
  } else if (hasVault && !unlocked) {
    _vaultMode = "unlock";
    summary.textContent = "▸ Cross-device relive · Locked";
    disc.style.display = "none";
    $("vaultRow").style.display = "";
    pass2.style.display = "none";
    change.style.display = "none";
    btn.textContent = "Unlock";
  } else {
    _vaultMode = "off";
    summary.textContent = "▸ Cross-device relive · Off";
    disc.style.display = "";
    disc.textContent = "Set a passphrase to relive your letters on any device you sign into. Make it long: a few random words you'll remember (12+ characters). It never leaves your device, so we can't see it or reset it; if you forget it, re-set it from a device you're already on. Write it down.";
    $("vaultRow").style.display = "";
    pass2.style.display = "";
    change.style.display = "none";
    btn.textContent = "Enable";
  }
}

// ---------- handlers ----------

// Auth button handlers
$("signInBtn").addEventListener("click", openAuthPage);
$("accountLink").addEventListener("click", (e) => { e.preventDefault(); openAccountPage(); });
$("signOutLink").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.storage.local.remove("ks_session");
  // Lock the vault on this device (clears the cached master key). The vault
  // itself stays on the server; the user re-unlocks with their passphrase.
  await chrome.storage.local.remove("ks_vault");
  _session = null;
  _sessionExpired = false;
  $("authGate").classList.remove("hidden");
  $("authBar").classList.add("hidden");
  const vb = $("vaultBlock"); if (vb) vb.style.display = "none";
  // Clear previous shares from view immediately
  const list = $("previousList");
  const header = $("prevHeader");
  if (list) list.innerHTML = "";
  if (header) header.style.display = "none";
});

// Vault: enable / unlock / change passphrase (guarded — element may be absent)
$("vaultBtn")?.addEventListener("click", async () => {
  const btn = $("vaultBtn");
  const status = $("vaultStatus");
  const pass = $("vaultPass").value.trim();
  if (!pass) { status.textContent = "Enter a passphrase."; return; }
  if (_vaultMode === "unlock") {
    btn.disabled = true; status.textContent = "Unlocking…";
    try {
      await vaultUnlock(pass);
      status.textContent = "Unlocked ✦ Your letters are now on this device.";
      await refreshAuthUI();
      renderPrevious().catch(() => {});
    } catch (err) {
      status.textContent = err.message === "wrong passphrase" ? "Wrong passphrase." : "Couldn't unlock. Check your connection.";
    }
    btn.disabled = false;
  } else {
    // setup / change
    const pass2 = $("vaultPass2").value.trim();
    if (pass.length < 12) { status.textContent = "Use at least 12 characters. A few random words is ideal."; return; }
    if (pass !== pass2) { status.textContent = "Passphrases don't match."; return; }
    btn.disabled = true; status.textContent = "Setting up…";
    try { await vaultSetup(pass); status.textContent = "Cross-device on ✦"; await refreshAuthUI(); }
    catch (err) { status.textContent = "Couldn't set up. Check your connection."; }
    btn.disabled = false;
  }
});

// "Change passphrase" from the On state → re-show the setup form (re-keys the vault
// from this device, which is also the "forgot passphrase, re-set it" path).
$("vaultChange")?.addEventListener("click", (e) => {
  e.preventDefault();
  _vaultMode = "off";
  $("vaultDisclaimer").style.display = "";
  $("vaultDisclaimer").textContent = "Pick a new passphrase. This re-keys your vault from this device.";
  $("vaultRow").style.display = "";
  $("vaultPass2").style.display = "";
  $("vaultChange").style.display = "none";
  $("vaultBtn").textContent = "Save new passphrase";
  $("vaultStatus").textContent = "";
});

$("saveName").addEventListener("click", async () => {
  const v = $("senderName").value.trim();
  if (!v) return;
  senderName = v;
  await chrome.storage.local.set({ ks_sender: v });
  if (activeShare) {
    activeShare.sender_name = v;
    const { store } = await loadStore();
    store.shares[activeShare.id] = activeShare;
    await saveStore(store).catch(console.error);
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
  await saveStore(store).catch(console.error);
});
$("shareDescription")?.addEventListener("input", async () => {
  if (!activeShare) return;
  activeShare.description = $("shareDescription").value.trim() || null;
  const { store } = await loadStore();
  store.shares[activeShare.id] = activeShare;
  await saveStore(store).catch(console.error);
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
  if (!currentTrack) { btn.disabled = false; return ($("status").textContent = "Play a song on Spotify first."); }
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
  try {
    await saveStore(store);
  } catch {
    // Roll back the in-memory push so the UI stays consistent with storage.
    activeShare.notes.pop();
    btn.disabled = false;
    $("status").textContent = "Couldn't save. Storage is full. Delete some old notes and try again.";
    return;
  }
  setMode("editing");

  btn.disabled = false;
  $("note").value = "";
  $("ts").value = "";
  $("status").textContent = "Saved ✓";
  setTimeout(() => ($("status").textContent = ""), 2000);
  renderNotes();
  renderSharePanel().catch(console.error);
  notifyContentRefresh();
});

$("attachBtn").addEventListener("click", attachPlaylist);

$("copyShare").addEventListener("click", async () => {
  const shareBtn = $("copyShare");
  if (shareBtn.disabled) return;
  shareBtn.disabled = true;

  // ── Experience mode: just copy the already-generated link ──
  if (activeShare?.mode === "experience") {
    if (!activeShare.enc_key) { shareBtn.disabled = false; return; }
    const url = `${shareUrl(activeShare.id)}&e=1#k=${activeShare.enc_key}`;
    try {
      await navigator.clipboard.writeText(url);
      shareBtn.textContent = "Copied!";
      setTimeout(() => { shareBtn.textContent = "COPY LINK"; }, 2000);
    } catch {}
    shareBtn.disabled = false;
    return;
  }

  // ── Tutorial practice: don't really send (no server, no credit). ──
  if (activeShare?.is_trial) {
    shareBtn.disabled = false;
    $("shareInfo").innerHTML =
      "This is practice, so nothing was sent. In a real share you'd get a link here to send to anyone. ✦";
    return;
  }

  // ── Step 1: Auth check ──
  const session = await getSession();
  if (!session) {
    $("shareInfo").innerHTML = `Sign in to send letters. <a href="#" id="signInLink" style="color:var(--tangerine);font-weight:600">Sign in</a>`;
    document.getElementById("signInLink")?.addEventListener("click", (e) => { e.preventDefault(); openAuthPage(); });
    shareBtn.disabled = false;
    return;
  }

  // ── Step 2: Validate before touching credits ──
  if (!activeShare.notes.length) {
    $("shareInfo").textContent = "Write at least one note before sending.";
    shareBtn.disabled = false;
    return;
  }
  const trackIds = new Set(activeShare.notes.map((n) => n.track_id));
  const isMulti = trackIds.size > 1;
  const playlistId = parsePlaylistId($("playlistUrl").value);
  if (isMulti && !playlistId) {
    $("shareInfo").textContent = "Add a playlist link to share notes across multiple songs";
    shareBtn.disabled = false;
    return;
  }

  // ── Step 3: Check credits are available (read-only — not consumed yet) ──
  const credits = await fetchCredits(session.access_token, session.user.id);
  const hasCredit = credits && (
    credits.lifetime ||
    credits.paid_credits > 0 ||
    freeCreditsRemaining(credits) > 0
  );
  if (!hasCredit) {
    $("shareInfo").innerHTML = `No letters left. <a href="#" id="buyLink" style="color:var(--tangerine);font-weight:600">Buy more →</a>`;
    document.getElementById("buyLink")?.addEventListener("click", (e) => { e.preventDefault(); openAccountPage(); });
    shareBtn.disabled = false;
    return;
  }

  // ── Step 4: Prepare share (sanitize, dedup, mint new ID) ──
  const v = $("playlistUrl").value.trim();
  activeShare.playlist_url = v || null;
  activeShare.playlist_id = parsePlaylistId(v);
  activeShare.type = deriveType(activeShare);
  // Ensure playlist_name is set at share time — the change-event oEmbed fetch
  // may not have completed before the user clicked Share (race condition).
  if (activeShare.playlist_id && !activeShare.playlist_name) {
    try {
      const oembed = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(v)}`);
      if (oembed.ok) {
        const d = await oembed.json();
        activeShare.playlist_name = d.title || "A Playlist Share";
        activeShare.thumbnail_url = d.thumbnail_url || null;
      } else {
        activeShare.playlist_name = "A Playlist Share";
      }
    } catch {
      activeShare.playlist_name = "A Playlist Share";
    }
  } else if (!activeShare.playlist_id) {
    activeShare.playlist_name = null;
    activeShare.thumbnail_url = null;
  }
  activeShare.notes = sanitizeNotes(activeShare.notes);
  const seen = new Set();
  activeShare.notes = activeShare.notes.filter((n) => {
    const key = `${n.track_id}|${n.timestamp ?? ""}|${n.note}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Always mint a fresh share ID on every send so orphaned rows are unreachable.
  const { store } = await loadStore();
  const oldId = activeShare.id;
  const newId = shortId();
  activeShare.id = newId;
  activeShare.mode = "inactive";
  delete store.shares[oldId];
  store.shares[newId] = activeShare;
  store.active = newId;

  // ── Step 5: Encrypt everything before it leaves the device ──
  $("shareInfo").textContent = "Encrypting…";
  const encKey = await generateEncKey();
  const keyB64 = await exportEncKey(encKey);
  // Store the key locally so reactivation can decrypt notes fetched from Supabase.
  activeShare.enc_key = keyB64;
  store.shares[newId] = activeShare;

  // Only note text is encrypted — names and song metadata stay plaintext.
  const shareToPush = {
    ...activeShare,
    sender_name:    activeShare.sender_name || senderName,
    recipient_name: activeShare.recipient_name || null,
    // Description is end-to-end encrypted (zero-knowledge), like note text.
    description:    activeShare.description ? await encryptField(activeShare.description, encKey) : null,
    // Sender copy — encrypted with the same enc_key as the share.
    // Decrypted client-side on notes.html via the extension or a pasted share link.
    // Server only ever sees the encrypted blob.
    sender_content: await encryptField(JSON.stringify({
      recipient_name: activeShare.recipient_name || null,
      description: activeShare.description || null,
      notes: activeShare.notes.map(n => ({
        note:         n.note,
        timestamp:    n.timestamp ?? null,
        track_title:  n.track_title  || null,
        track_artist: n.track_artist || null,
        track_id:     n.track_id     || null,
      })),
    }), encKey),
  };
  // Encrypt each note's personal fields
  const notesToPush = await Promise.all(
    activeShare.notes.map(n => encryptNoteFields(n, encKey))
  );

  // ── Step 6: Atomically consume a credit + create the share (server-enforced).
  // ONE rpc = ONE transaction: either a credit is spent AND the share is
  // created, or neither happens. The credit gate lives on the server now, so a
  // client can't bypass it by inserting rows directly.
  $("shareInfo").textContent = "Sending…";
  const p_notes = notesToPush.map((n) => ({
    track_id:     n.track_id,
    note:         n.note,                       // already encrypted
    timestamp:    n.timestamp ?? null,
    sender_name:  n.sender_name || senderName || "someone",
    track_title:  n.track_title || null,
    track_artist: n.track_artist || null,
    playlist_id:  activeShare.playlist_id || null,
  }));
  const { data: shareResult, error: shareErr } = await supabaseRpc("create_share", {
    p_id:             shareToPush.id,
    p_share_type:     shareToPush.type,
    p_playlist_id:    shareToPush.playlist_id || null,
    p_playlist_url:   shareToPush.playlist_url || null,
    p_playlist_name:  shareToPush.playlist_name || null,
    p_sender_name:    shareToPush.sender_name || senderName || "someone",
    p_recipient_name: shareToPush.recipient_name || null,
    p_description:    shareToPush.description || null,
    p_sender_content: shareToPush.sender_content || null,
    p_notes,
  }, session.access_token);

  // Roll the local ID swap back so the user can retry without losing anything.
  const rollbackShare = (msg) => {
    activeShare.id = oldId;
    activeShare.mode = "editing";
    activeShare.enc_key = null;
    delete store.shares[newId];
    store.shares[oldId] = activeShare;
    store.active = oldId;
    saveStore(store).catch(console.error);
    if (msg) $("shareInfo").textContent = msg;
    shareBtn.disabled = false;
  };

  if (shareErr || !shareResult?.ok) {
    const err = shareResult && shareResult.error;
    if (err === "no_credit") {
      rollbackShare("");
      $("shareInfo").innerHTML = `No letters left. <a href="#" id="buyLink" style="color:var(--tangerine);font-weight:600">Buy more →</a>`;
      document.getElementById("buyLink")?.addEventListener("click", (e) => { e.preventDefault(); openAccountPage(); });
      return;
    }
    if (err === "not_authenticated") { rollbackShare("Your session expired. Please sign in again."); return; }
    rollbackShare(shareErr
      ? "Couldn't reach the server. Check your connection and try again."
      : "Couldn't send your letter. Please try again.");
    return;
  }

  // Share + credit are committed together. If the vault is set up + unlocked on
  // this device, also store this letter's key wrapped so it can be relived on
  // other devices the user signs into.
  (async () => {
    try {
      const mk = await getVaultMasterKey();
      if (mk) {
        await upsertVaultKeys(
          [{ user_id: session.user.id, share_id: activeShare.id, wrapped_key: await encryptField(keyB64, mk) }],
          session.access_token
        );
      }
    } catch (err) { console.warn("Keepsake: vault wrap on send failed", err); }
  })();

  // Refresh the credits badge immediately so the user sees the deduction
  // without needing to close and reopen the extension.
  fetchCredits(session.access_token, session.user.id).then((c) => {
    const badge = $("creditsBadge");
    if (!badge) return;
    badge.textContent = creditsLabel(c);
    if (c && !c.lifetime && c.paid_credits === 0 && freeCreditsRemaining(c) === 0) {
      badge.classList.add("empty");
    } else {
      badge.classList.remove("empty");
    }
  }).catch(() => {});

  // ── Step 8: Finalise local state and show the link ──
  // Key lives only in the URL fragment — never stored anywhere server-side.
  try {
    await saveStore(store);
  } catch {
    // Notes are already in Supabase — the share was sent successfully.
    // Local state just couldn't be persisted. Show the link anyway so
    // the user can still copy and send it; warn about the storage issue.
    shareBtn.disabled = false;
    const url = `${shareUrl(activeShare.id)}&e=1#k=${encodeURIComponent(keyB64)}`;
    $("shareInfo").innerHTML = `Share sent! But storage is full, so your local notes may be out of sync. Link: <a href="${url}" target="_blank">${url}</a>`;
    return;
  }
  shareBtn.disabled = false;
  setMode("inactive");
  notifyContentRefresh();

  // &e=1 signals to the share page that this link is encrypted.
  // If a messaging app or email client strips the URL fragment (#k=…),
  // the share page detects e=1 without a key and shows a helpful
  // "part of your link got cut off" message instead of a generic error.
  const url = `${shareUrl(activeShare.id)}&e=1#k=${encodeURIComponent(keyB64)}`;
  try { await navigator.clipboard.writeText(url); } catch { /* fallback below */ }
  $("shareInfo").innerHTML =
    `<button id="copyLinkBtn" class="copy-link-btn">✦ Copy link to share</button>`;
  $("copyLinkBtn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(url).catch(() => {});
    $("copyLinkBtn").textContent = "Copied!";
    setTimeout(() => { if ($("copyLinkBtn")) $("copyLinkBtn").textContent = "✦ Copy link to share"; }, 2000);
  });
});

$("resetShare").addEventListener("click", async () => {
  const { store } = await loadStore();
  const current = store.shares[store.active];
  const wasRelived = !!current?.relived;
  const { ks_tutorial } = await chrome.storage.local.get("ks_tutorial");
  const tutorialActive = !!(ks_tutorial && ks_tutorial.active);

  // Relived letters go *back* to previous; everything else is *moved* there.
  const confirmMsg = wasRelived
    ? "Return this letter to previous experiences?"
    : "Start a new share? Your current letter will be moved to ‘previous experiences’.";
  if (!confirm(confirmMsg)) return;

  await archiveActive(store);
  store.active = null;

  // If we just finished reviewing a relived share and there was a working
  // share open before reactivation, restore it instead of creating a blank.
  const displaced = store.displacedActive;
  if (wasRelived && displaced && store.shares[displaced]) {
    store.active = displaced;
    store.previous = (store.previous || []).filter((x) => x !== displaced);
    store.displacedActive = null;
    activeShare = store.shares[displaced];
  } else {
    store.displacedActive = null;
    ensureActive(store, senderName);
    activeShare = store.shares[store.active];
  }

  // Leaving experience mode: the new/restored share must be editable, otherwise
  // the experience banner stays up and the composer stays hidden.
  activeShare.mode = "editing";
  activeShare.relived = false;
  // Stay in the practice sandbox while the tutorial is running.
  if (tutorialActive) activeShare.is_trial = true;
  store.shares[store.active] = activeShare;

  await saveStore(store).catch(console.error);
  $("shareInfo").textContent = "";
  $("playlistUrl").value = activeShare.playlist_url || "";
  $("recipientName").value = activeShare.recipient_name || "";
  if ($("shareDescription")) $("shareDescription").value = activeShare.description || "";
  setMode("editing");
  renderExperienceBanner(); // hides the experience banner, restores the composer
  renderNotes();
  renderSharePanel().catch(console.error);
  renderPrevious();
  notifyContentRefresh();
});

$("enterEditMode")?.addEventListener("click", async () => {
  if (!activeShare) return;
  const { store } = await loadStore();
  const orig = store.shares[activeShare.id];

  if (orig && orig.enc_key) {
    // Fork-on-edit: a sent/relived letter can't be mutated in place (the
    // original link must keep working). Return the original to Previous
    // untouched, and edit a fresh, unsent clone instead. Re-sharing the
    // clone creates a brand-new link; the original stays as it was.
    const clonedNotes = (orig.notes || []).map((n) => ({ ...n }));
    orig.note_count = (orig.notes || []).length;
    orig.song_count = new Set((orig.notes || []).map((n) => n.track_id)).size;
    orig.notes = [];
    orig.mode = "inactive";
    orig.relived = false;
    store.previous = [orig.id, ...(store.previous || []).filter((x) => x !== orig.id)];

    const clone = {
      ...orig,
      id: shortId(),
      enc_key: null,
      imported: false,
      is_trial: false,
      relived: false,
      mode: "editing",
      note_count: undefined,
      song_count: undefined,
      notes: clonedNotes,
      created_at: Date.now(),
    };
    store.shares[clone.id] = clone;
    store.active = clone.id;
    activeShare = clone;
  } else {
    // Unsent draft — just make it editable in place.
    activeShare.mode = "editing";
    store.shares[activeShare.id] = activeShare;
  }

  await saveStore(store).catch(console.error);
  $("playlistUrl").value = activeShare.playlist_url || "";
  $("recipientName").value = activeShare.recipient_name || "";
  if ($("shareDescription")) $("shareDescription").value = activeShare.description || "";
  renderExperienceBanner(); // hides banner, restores composer
  showComposer(!!senderName);
  renderNotes();
  renderSharePanel().catch(console.error);
  renderPrevious();
});

$("importBtn").addEventListener("click", async () => {
  const raw = $("importId").value.trim();
  if (!raw) return;

  // Extract share ID from whatever format was pasted
  let v = raw;
  const mPath  = raw.match(/\/share\/([a-z0-9_-]+)/i);
  const mQuery = raw.match(/[?&]id=([a-z0-9_-]+)/i);
  if (mPath)  v = mPath[1];
  else if (mQuery) v = mQuery[1];

  // Extract encryption key from URL fragment if present
  const mKey = raw.match(/#k=([A-Za-z0-9+/=]+)/);
  const importKeyB64 = mKey ? mKey[1] : null;

  $("importStatus").textContent = "Fetching…";

  const { store } = await loadStore();
  if (store.active === v) {
    $("importStatus").textContent = "This letter is already active.";
    return;
  }
  if (store.shares[v]) {
    await reliveShare(v);
    $("importStatus").textContent = "Reactivated.";
    return;
  }

  const [meta, remote] = await Promise.all([fetchShareMeta(v), fetchShareNotes(v)]);
  if (!remote.length && !meta) {
    $("importStatus").textContent = "No notes found for that link.";
    return;
  }

  // Decrypt if a key was found in the pasted URL
  let decryptedRemote = remote;
  let decryptedMeta   = meta ? { ...meta } : null;
  if (importKeyB64) {
    try {
      const importKey = await importEncKey(importKeyB64);
      decryptedRemote = await Promise.all(remote.map(n => decryptNoteFields(n, importKey)));
      if (decryptedMeta) {
        decryptedMeta.sender_name    = await decryptField(decryptedMeta.sender_name, importKey);
        decryptedMeta.recipient_name = decryptedMeta.recipient_name
          ? await decryptField(decryptedMeta.recipient_name, importKey)
          : null;
        decryptedMeta.description = decryptedMeta.description
          ? await decryptField(decryptedMeta.description, importKey)
          : null;
      }
    } catch {
      $("importStatus").textContent = "Couldn't decrypt. Paste the full share link, not just the ID.";
      return;
    }
  }

  await archiveActive(store);

  const newShare = {
    id: v,
    mode: "editing",
    type: decryptedMeta?.share_type || (new Set(decryptedRemote.map((r) => r.track_id)).size > 1 ? "multi" : "single"),
    playlist_id: decryptedMeta?.playlist_id || decryptedRemote.find((r) => r.playlist_id)?.playlist_id || null,
    playlist_url: decryptedMeta?.playlist_url || null,
    sender_name: decryptedMeta?.sender_name || decryptedRemote[0]?.sender_name || "someone",
    // If no key was provided, recipient_name may arrive as a ciphertext blob —
    // null it out rather than storing/displaying garbage in the UI.
    recipient_name: decryptedMeta?.recipient_name && !looksEncrypted(decryptedMeta.recipient_name)
      ? decryptedMeta.recipient_name
      : null,
    description: decryptedMeta?.description && !looksEncrypted(decryptedMeta.description)
      ? decryptedMeta.description
      : null,
    enc_key: importKeyB64 || null, // stored so reactivation can decrypt from Supabase
    imported: true,
    created_at: Date.now(),
    notes: sanitizeNotes(decryptedRemote.map((r) => ({
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
  try {
    await saveStore(store);
  } catch {
    $("importStatus").textContent = "Couldn't import. Storage is full. Delete some old notes and try again.";
    return;
  }
  activeShare = newShare;
  setMode("editing");
  $("importStatus").textContent = `Imported ${remote.length} note${remote.length === 1 ? "" : "s"}.`;
  renderNotes();
  renderSharePanel().catch(console.error);
  renderPrevious();
  notifyContentRefresh();

  // Record this import server-side so it appears in the Received tab on
  // notes.html for this user, persisted across devices and reinstalls.
  // Fire-and-forget — local import already succeeded above.
  // resolution=ignore-duplicates handles re-imports of the same share gracefully.
  getSession().then(session => {
    if (!session) return;
    fetch(`${SUPABASE_URL}/rest/v1/received_shares`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify({ user_id: session.user.id, share_id: v }),
    }).catch(console.warn);

    // Vault: if set up + unlocked, store the imported key wrapped too, so the
    // recipient can relive this received letter on their other devices.
    getVaultMasterKey().then(async (mk) => {
      if (!mk || !importKeyB64) return;
      try {
        await upsertVaultKeys(
          [{ user_id: session.user.id, share_id: v, wrapped_key: await encryptField(importKeyB64, mk) }],
          session.access_token
        );
      } catch (err) { console.warn("Keepsake: vault wrap on import failed", err); }
    });
  });
});

// Run init and startLiveTracking independently so a mid-init error
// can't prevent the live tracking interval from starting.
init().catch(console.error);
startLiveTracking();

// Also listen for push notifications from the content script's tick() loop.
// This is the primary track-change signal — it fires the moment content.js
// detects a new song, without waiting for a poll cycle.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "KS_TRACK_CHANGED") {
    const changed = !currentTrack ||
      currentTrack.trackId !== msg.trackId ||
      currentTrack.title   !== msg.title;
    if (!changed) return;
    currentTrack = { trackId: msg.trackId, title: msg.title, artist: msg.artist };
    $("trackTitle").textContent = msg.title  || "Unknown track";
    $("trackArtist").textContent = msg.artist || "";
    renderNotes();
    renderSharePanel().catch(console.error);
  }
});

// ---- Live track polling ----
// The side panel stays open indefinitely, so we poll for track changes
// rather than relying on the user to reopen the panel for each song.
// Runs every 2 s; skips when the document is hidden (tab in background).
// Only re-renders when the track actually changes — no UI flicker.
function startLiveTracking() {
  setInterval(async () => {
    // NOTE: do not guard on document.hidden — in a side panel Chrome may consider
    // the panel hidden whenever the user is focused on Spotify, which would cause
    // every poll to be skipped and the track to never update.
    const state = await fetchTrack();
    if (!state) return;
    const newId = state.trackId || null;
    const newTitle = state.title || null;
    const curId = currentTrack?.trackId ?? null;
    const curTitle = currentTrack?.title ?? null;
    // Compare both trackId AND title — the href React uses for trackId can lag
    // behind the title update by one render cycle, so title alone is enough signal.
    if (newId === curId && newTitle === curTitle) return; // nothing changed

    currentTrack = state.trackId ? state : null;

    if (state.trackId) {
      $("trackTitle").textContent = state.title || "Unknown track";
      $("trackArtist").textContent = state.artist || "";
    } else if (state.notOnSpotify) {
      $("trackTitle").textContent = "No song playing";
      $("trackArtist").textContent = "Open Spotify Web Player to start";
    } else if (!state.playerVisible) {
      $("trackTitle").textContent = "Player not detected";
      $("trackArtist").textContent = "Spotify may have updated. Check for a Keepsake update";
    } else {
      $("trackTitle").textContent = "Nothing playing";
      $("trackArtist").textContent = "Play a song to get started";
    }

    renderNotes();
    renderSharePanel().catch(console.error);
  }, 2000);
}

// ── Tutorial overlay ───────────────────────────────────────────────────────
// The tutorial is a decoupled overlay stored under its OWN key (ks_tutorial),
// not as a share. The user always works in a normal, real, auto-saved share —
// so anything meaningful they make during the tutorial persists like any
// keepsake, and empty "just testing" shares are discarded by the usual
// blank-share cleanup. Tutorial notes never mix with or pollute real shares.
const TUTORIAL_TOTAL = 12;
const TUTORIAL_VERSION = 8; // bump when copy changes → existing installs self-heal
function makeTutorialNote(id, step, ts, title, text) {
  return { id, timestamp: ts, is_tutorial: true,
           tutorial_step: step, tutorial_total: TUTORIAL_TOTAL,
           sender_name: "Keepsake", title, note: text };
}
function buildTutorialNotes() {
  return [
    makeTutorialNote("t01", 1,  0,   "Welcome to Keepsake", "These little notes will show you the way. Open the side panel to follow along: tap the Keepsake icon up in your toolbar."),
    makeTutorialNote("t02", 2,  10,  "Good to know", "These notes pop up as the song plays. Pause or rewind anytime and they'll trigger again, so nothing slips by."),
    makeTutorialNote("t03", 3,  20,  "Start with your name", "It's the signature on every keepsake you send, so whoever opens one knows it came from you."),
    makeTutorialNote("t04", 4,  30,  "Who is it for?", "Add their name in the panel. Whoever you're thinking of right now, this one's for them."),
    makeTutorialNote("t05", 5,  40,  "Write your note", "Whatever this moment in the song stirs in you, say it right here."),
    makeTutorialNote("t06", 6,  50,  "Pin it to the second", "Tap Now to catch the current time, or type the timestamp in yourself if a moment is calling you."),
    makeTutorialNote("t07", 7,  60,  "Save it", "Hit Save and it's sealed. Add as many notes as you like, across as many songs."),
    makeTutorialNote("t08", 8,  70,  "Add a description", "Scroll to the share panel and leave a little description. It's the first thing they read, before a single note plays."),
    makeTutorialNote("t09", 9,  80,  "Share it", "Hit SHARE for your link. Wrote across a few songs? You'll drop in the playlist link first."),
    makeTutorialNote("t10", 10, 90,  "Send it off", "To anyone, anywhere. It opens as a quiet little card holding every note you left. If they add Keepsake, your notes come alive as they listen."),
    makeTutorialNote("t11", 11, 100, "Relive anywhere", "Turn on Cross-device relive and pick a private passphrase. Your keepsakes follow you across devices, and only you can unlock them."),
    makeTutorialNote("t12", 12, 110, "That's everything", "Now go make someone's day. ✦"),
  ];
}
function buildTutorialOverlay(active) {
  // nameCardPending is a one-shot: the next panel open leads with the name
  // card (tutorial step 2), then clears so reopens don't keep forcing it.
  return { active: !!active, version: TUTORIAL_VERSION, nameCardPending: !!active, notes: buildTutorialNotes() };
}

// Discards every trial (tutorial-practice) share. Practice is never saved.
function purgeTrialShares(store) {
  for (const id of Object.keys(store.shares || {})) {
    if (store.shares[id].is_trial) {
      delete store.shares[id];
      store.previous = (store.previous || []).filter((x) => x !== id);
      if (store.active === id) store.active = null;
    }
  }
}

async function activateTutorial() {
  const { store } = await loadStore();
  // Preserve real work; drop any blank/trial currently open.
  const cur = store.active ? store.shares[store.active] : null;
  if (cur && !cur.is_trial && !isBlankShare(cur)) {
    store.previous = [store.active, ...(store.previous || []).filter((x) => x !== store.active)];
  }
  purgeTrialShares(store);
  // Start a fresh trial sandbox — anything written here is discarded later.
  const trial = makeBlankShare(senderName, { is_trial: true });
  store.shares[trial.id] = trial;
  store.active = trial.id;
  await saveStore(store);
  // Replay shows the name card right now, so the pending flag is already
  // consumed (reopening mid-tutorial won't force it again).
  await chrome.storage.local.set({
    ks_tutorial: { ...buildTutorialOverlay(true), nameCardPending: false },
    ks_onboarding: { started: true, seen: false },
  });
  activeShare = trial;
  $("playlistUrl").value = "";
  $("recipientName").value = "";
  if ($("shareDescription")) $("shareDescription").value = "";
  setMode("editing");
  renderExperienceBanner();
  showComposer(false); // tutorial leads with the name card (step 2)
  renderNotes();
  renderSharePanel().catch(console.error);
  renderPrevious();
  await renderTutorialUI();
  notifyContentRefresh();
}

async function dismissTutorial() {
  const { store } = await loadStore();
  purgeTrialShares(store);          // throw away all practice
  ensureActive(store, senderName);  // fresh blank real share
  await saveStore(store);
  const { ks_tutorial } = await chrome.storage.local.get("ks_tutorial");
  await chrome.storage.local.set({
    ks_tutorial: { ...(ks_tutorial || buildTutorialOverlay(false)), active: false },
    ks_onboarding: { started: true, seen: true },
  });
  activeShare = store.shares[store.active];
  $("playlistUrl").value = "";
  $("recipientName").value = "";
  if ($("shareDescription")) $("shareDescription").value = "";
  setMode("editing");
  renderExperienceBanner();
  showComposer(!!senderName);
  renderNotes();
  renderSharePanel().catch(console.error);
  renderPrevious();
  await renderTutorialUI();
  notifyContentRefresh();
}

$("replayTutorialBtn")?.addEventListener("click", () => activateTutorial());
$("tutorialCloseBtn")?.addEventListener("click", () => dismissTutorial());

// Auto-refresh auth UI when ks_session is written by auth-bridge.js
// (fires when the user logs in via auth.html without needing to restart the extension)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.ks_session) {
    _session = null; // invalidate in-memory cache so getSession() re-reads
    _sessionExpired = false;
    const newSess = changes.ks_session.newValue;
    if (newSess && newSess.user && newSess.user.id) {
      // A session was (re)written. If it's a different account than the local
      // data belongs to, wipe it and reload the panel for a clean slate.
      enforceAccountScope(newSess)
        .then((wiped) => (wiped ? location.reload() : refreshAuthUI()))
        .catch(console.error);
    } else {
      refreshAuthUI().catch(console.error);
    }
  }
});
