// Runs on auth.html — syncs Supabase session into extension storage
// so popup.js can read it without needing the auth page to stay open.
(function () {
  window.addEventListener("songnotes:auth", (e) => {
    if (!e.detail?.access_token) return;
    chrome.storage.local.set({ sn_session: e.detail }, () => {
      // Signal the page so it can show a "connected" state if needed
      window.dispatchEvent(new CustomEvent("songnotes:auth_saved"));
    });
  });

  window.addEventListener("songnotes:signout", () => {
    chrome.storage.local.remove("sn_session");
  });
})();
