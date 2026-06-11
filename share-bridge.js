// Bridges share pages → extension storage using the share-scoped storage model.
// The share page sets window.__KS_PAYLOAD = { share_id, share, notes: [...] } and dispatches "keepsake:import".
(function () {
  // Public anon config (safe to expose; same values as config.js / notes-bridge.js).
  const SB_URL = "https://kkasgbkgwjxiutdalbbm.supabase.co";
  const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtrYXNnYmtnd2p4aXV0ZGFsYmJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjU3OTQsImV4cCI6MjA5Mjg0MTc5NH0.z1JLMTzz3X_swbWHdt2z4UDKyUwjEfNYys5kdDMq3R4";

  // If the recipient is signed in on dropakeepsake.com, record the import in
  // received_shares so it appears in their Received tab on notes.html (and across
  // devices). Fire-and-forget; the local import already gives them the notes.
  function persistReceived(shareId) {
    try {
      let raw = null;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("sb-") && k.endsWith("-auth-token")) { raw = localStorage.getItem(k); break; }
      }
      if (!raw) return; // not signed in — the local import is enough on its own
      const sess = JSON.parse(raw);
      const token = sess && sess.access_token;
      const uid = sess && sess.user && sess.user.id;
      if (!token || !uid) return;
      fetch(`${SB_URL}/rest/v1/received_shares`, {
        method: "POST",
        headers: {
          apikey: SB_KEY,
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          Prefer: "resolution=ignore-duplicates,return=minimal",
        },
        body: JSON.stringify({ user_id: uid, share_id: shareId }),
      }).catch(() => {});
    } catch (_) {}
  }

  function inject(payload) {
    if (!payload || !payload.share_id) return;
    const incomingId = payload.share_id;
    const remoteNotes = Array.isArray(payload.notes) ? payload.notes : [];
    const meta = payload.share || {};
    persistReceived(incomingId);

    chrome.storage.local.get(["ks_shares"], (data) => {
      const store = data.ks_shares || { active: null, shares: {}, previous: [] };

      // Same id as active → no-op (do not duplicate or replace)
      if (store.active === incomingId) {
        window.dispatchEvent(new CustomEvent("keepsake:imported", { detail: { added: 0, alreadyActive: true } }));
        return;
      }

      // Archive currently active to "previous" if different
      if (store.active && store.active !== incomingId) {
        store.previous = [store.active, ...(store.previous || []).filter((x) => x !== store.active)];
      }
      // Remove incoming from previous if it was there (it's becoming active again)
      store.previous = (store.previous || []).filter((x) => x !== incomingId);

      const trackIds = new Set(remoteNotes.map((r) => r.track_id));
      const derivedType =
        meta.share_type ||
        (meta.playlist_id || meta.playlist_url ? "playlist" : trackIds.size > 1 ? "multi" : "single");

      store.shares[incomingId] = {
        id: incomingId,
        mode: "editing", // receiver should hear popups
        type: derivedType,
        playlist_id: meta.playlist_id || remoteNotes.find((r) => r.playlist_id)?.playlist_id || null,
        playlist_url: meta.playlist_url || null,
        sender_name: meta.sender_name || remoteNotes[0]?.sender_name || "someone",
        imported: true,
        created_at: Date.now(),
        notes: remoteNotes.map((r) => ({
          id: r.id,
          track_id: r.track_id,
          track_title: r.track_title || null,
          track_artist: r.track_artist || null,
          note: r.note,
          timestamp: r.timestamp,
          sender_name: r.sender_name,
          created_at: new Date(r.created_at).getTime(),
        })),
      };
      store.active = incomingId;

      chrome.storage.local.set({ ks_shares: store }, () => {
        window.dispatchEvent(new CustomEvent("keepsake:imported", { detail: { added: remoteNotes.length } }));
      });
    });
  }

  document.documentElement.setAttribute("data-keepsake-installed", "1");
  window.dispatchEvent(new CustomEvent("keepsake:ready"));

  window.addEventListener("keepsake:import", (e) => {
    inject(e.detail || window.__KS_PAYLOAD);
  });
  if (window.__KS_PAYLOAD) inject(window.__KS_PAYLOAD);
})();
