// Bridges share pages → extension storage using the share-scoped storage model.
// The share page sets window.__SN_PAYLOAD = { share_id, share, notes: [...] } and dispatches "songnotes:import".
(function () {
  function inject(payload) {
    if (!payload || !payload.share_id) return;
    const incomingId = payload.share_id;
    const remoteNotes = Array.isArray(payload.notes) ? payload.notes : [];
    const meta = payload.share || {};

    chrome.storage.local.get(["sn_shares"], (data) => {
      const store = data.sn_shares || { active: null, shares: {}, previous: [] };

      // Same id as active → no-op (do not duplicate or replace)
      if (store.active === incomingId) {
        window.dispatchEvent(new CustomEvent("songnotes:imported", { detail: { added: 0, alreadyActive: true } }));
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

      chrome.storage.local.set({ sn_shares: store }, () => {
        window.dispatchEvent(new CustomEvent("songnotes:imported", { detail: { added: remoteNotes.length } }));
      });
    });
  }

  document.documentElement.setAttribute("data-songnotes-installed", "1");
  window.dispatchEvent(new CustomEvent("songnotes:ready"));
  try { chrome.storage.local.set({ sn_share_origin: window.location.origin }); } catch (e) {}

  window.addEventListener("songnotes:import", (e) => {
    inject(e.detail || window.__SN_PAYLOAD);
  });
  if (window.__SN_PAYLOAD) inject(window.__SN_PAYLOAD);
})();
