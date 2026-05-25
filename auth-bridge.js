// Runs on auth.html — syncs Supabase session into extension storage
// so popup.js can read it without needing the auth page to stay open.
(function () {
  window.addEventListener("keepsake:auth", (e) => {
    if (!e.detail?.access_token) return;
    chrome.storage.local.set({ ks_session: e.detail }, () => {
      // Signal the page so it can show a "connected" state if needed
      window.dispatchEvent(new CustomEvent("keepsake:auth_saved"));
    });
  });

  window.addEventListener("keepsake:signout", () => {
    chrome.storage.local.remove("ks_session", () => {
      // Tell the page the storage is clear — it waits for this before navigating
      window.dispatchEvent(new CustomEvent("keepsake:signout_done"));
    });
  });
})();
