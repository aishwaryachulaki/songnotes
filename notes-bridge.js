// Runs on notes.html — bridges the website to the extension:
//  • keepsake:get_share_key — page asks for a share's encryption key
//  • keepsake:relive        — page asks the extension to enter experience mode
//    for one of the user's letters (mirrors the popup's "Relive" button), so
//    notes fire on Spotify. The key never goes through the server.
(function () {
  // Public anon config (same values shipped in config.js — safe to expose).
  const SB_URL = "https://kkasgbkgwjxiutdalbbm.supabase.co";
  const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtrYXNnYmtnd2p4aXV0ZGFsYmJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjU3OTQsImV4cCI6MjA5Mjg0MTc5NH0.z1JLMTzz3X_swbWHdt2z4UDKyUwjEfNYys5kdDMq3R4";

  async function importEncKey(b64) {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  }
  async function decryptField(b64, key) {
    if (b64 == null) return null;
    try {
      const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
      return new TextDecoder().decode(dec);
    } catch {
      return b64; // old plaintext note — return as-is
    }
  }
  function reliveDone(shareId, ok, error) {
    window.dispatchEvent(new CustomEvent("keepsake:relive_response", {
      detail: { shareId, ok, error: error || null },
    }));
  }

  // ---- Hand the page a share's encryption key (used for copy-link / decrypt) ----
  window.addEventListener("keepsake:get_share_key", (e) => {
    const shareId = e.detail && e.detail.shareId;
    if (!shareId) return;
    chrome.storage.local.get("ks_shares", (result) => {
      const store = result.ks_shares || {};
      const shares = store.shares || {};
      const share = shares[shareId];
      const encKey = (share && share.enc_key) || null;
      window.dispatchEvent(new CustomEvent("keepsake:share_key_response", {
        detail: { shareId, encKey },
      }));
    });
  });

  // ---- Relive: activate one of the user's letters in experience mode ----
  window.addEventListener("keepsake:relive", (e) => {
    const shareId = e.detail && e.detail.shareId;
    if (!shareId) return reliveDone(shareId, false, "bad_request");

    chrome.storage.local.get("ks_shares", async (result) => {
      const store = result.ks_shares || { active: null, shares: {}, previous: [] };
      const share = store.shares[shareId];

      // If this device has no record of the letter (made elsewhere / store
      // cleared), we can't relive it — the key + notes aren't here.
      if (!share) return reliveDone(shareId, false, "not_on_device");

      // Sent letters get their notes stripped when archived; re-fetch + decrypt
      // from the server (get_share) using the locally-stored key. Received
      // letters already hold decrypted notes (and have no enc_key), so skip.
      if (!(share.notes && share.notes.length) && share.enc_key) {
        try {
          const r = await fetch(
            `${SB_URL}/rest/v1/rpc/get_share?p_share_id=${encodeURIComponent(shareId)}`,
            { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } }
          );
          const bundle = r.ok ? await r.json() : null;
          const remote = bundle && Array.isArray(bundle.notes) ? bundle.notes : [];
          if (remote.length) {
            const key = await importEncKey(share.enc_key);
            share.notes = await Promise.all(
              remote.map(async (n) => ({ ...n, note: await decryptField(n.note, key) }))
            );
          }
        } catch (_) {
          // Server unreachable — activate with whatever we have rather than blocking.
        }
      }

      // Push the currently-active share to "previous", activate this one read-only.
      if (store.active && store.active !== shareId) {
        store.previous = [store.active].concat((store.previous || []).filter((x) => x !== store.active));
      }
      store.previous = (store.previous || []).filter((x) => x !== shareId);
      store.active = shareId;
      // Both sent (your own) and received letters relive read-only in experience mode.
      share.mode = "experience";
      store.shares[shareId] = share;

      chrome.storage.local.set({ ks_shares: store }, () => reliveDone(shareId, true));
    });
  });

  // ---- Remove a deleted keepsake from this device's local storage ----
  window.addEventListener("keepsake:remove_share", (e) => {
    const shareId = e.detail && e.detail.shareId;
    if (!shareId) return;
    chrome.storage.local.get("ks_shares", (result) => {
      const store = result.ks_shares;
      if (!store || !store.shares || !store.shares[shareId]) return;
      delete store.shares[shareId];
      store.previous = (store.previous || []).filter((x) => x !== shareId);
      if (store.active === shareId) store.active = null;
      chrome.storage.local.set({ ks_shares: store });
    });
  });

  // ---- First-run onboarding state → drives the welcome cue on notes.html ----
  // The page shows its "make your first keepsake" module while the tutorial
  // hasn't been completed (ks_onboarding.seen === false).
  function emitOnboarding() {
    chrome.storage.local.get("ks_onboarding", (r) => {
      const o = r.ks_onboarding || {};
      window.dispatchEvent(new CustomEvent("keepsake:onboarding_state", {
        detail: { started: !!o.started, seen: !!o.seen, phase: o.phase || null },
      }));
    });
  }
  // Page-initiated dismiss → finish onboarding everywhere (mirrors the side
  // panel's dismissTutorial: mark seen + deactivate the tutorial overlay).
  window.addEventListener("keepsake:dismiss_onboarding", () => {
    chrome.storage.local.get(["ks_onboarding", "ks_tutorial"], (r) => {
      const onboarding = { ...(r.ks_onboarding || {}), started: true, seen: true };
      const tutorial = { ...(r.ks_tutorial || {}), active: false };
      chrome.storage.local.set({ ks_onboarding: onboarding, ks_tutorial: tutorial }, emitOnboarding);
    });
  });
  // Keep the cue in sync if the tour is finished/dismissed elsewhere.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.ks_onboarding || changes.ks_tutorial)) emitOnboarding();
  });

  // Let the page know the extension is present + its onboarding state
  window.dispatchEvent(new CustomEvent("keepsake:extension_present"));
  emitOnboarding();
})();
