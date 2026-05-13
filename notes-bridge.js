// Runs on notes.html — lets the page ask the extension for a share's
// encryption key without the key ever going through the server.
(function () {
  window.addEventListener("keepsake:get_share_key", async (e) => {
    const shareId = e.detail?.shareId;
    if (!shareId) return;

    chrome.storage.local.get("ks_shares", (result) => {
      const store = result.ks_shares || {};
      const shares = store.shares || {};
      const share = shares[shareId];
      const encKey = share?.enc_key || null;

      window.dispatchEvent(new CustomEvent("keepsake:share_key_response", {
        detail: { shareId, encKey }
      }));
    });
  });

  // Let the page know the extension is present
  window.dispatchEvent(new CustomEvent("keepsake:extension_present"));
})();
