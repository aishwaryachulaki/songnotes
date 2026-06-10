// Runs on the authed website pages (auth/account/sent/received/notes) — bridges
// the Supabase session between the website and the extension's storage.
//
// The website holds the REAL session (in its own localStorage); the extension
// keeps a mirror in chrome.storage (ks_session) so popup.js can read it without
// the website staying open. Logging out must work in BOTH directions:
//   • website → extension: keepsake:signout clears the mirror.
//   • extension → website: when the extension sets ks_logged_out, we clear the
//     website's OWN persisted session here, so a page reload can't silently
//     re-sync the login back into the extension.
(function () {
  // Remove the website's persisted Supabase session (key: sb-<ref>-auth-token).
  function clearWebsiteSession() {
    try {
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith("sb-") && k.endsWith("-auth-token")) localStorage.removeItem(k);
      });
    } catch (_) {}
  }

  // Drop the transient `event` field before mirroring the session into storage.
  function sessionOnly(detail) {
    const { event, ...rest } = detail;
    return rest;
  }

  function saveSession(detail) {
    chrome.storage.local.set({ ks_session: sessionOnly(detail) }, () => {
      window.dispatchEvent(new CustomEvent("keepsake:auth_saved"));
    });
  }

  window.addEventListener("keepsake:auth", (e) => {
    const detail = e.detail;
    if (!detail?.access_token) return;

    // A deliberate sign-in (only auth.html sends event:"SIGNED_IN") overrides any
    // prior "logged out" intent — this is the user choosing to log back in.
    if (detail.event === "SIGNED_IN") {
      chrome.storage.local.remove("ks_logged_out", () => saveSession(detail));
      return;
    }

    // Otherwise this is a page restoring a persisted session (INITIAL_SESSION, a
    // token refresh, or a mirror push from notes/account/etc.). If the user
    // signed out in the extension, DON'T re-sync — clear this site's session too.
    chrome.storage.local.get(["ks_logged_out"], (r) => {
      if (r.ks_logged_out) {
        clearWebsiteSession();
        location.reload();
        return;
      }
      saveSession(detail);
    });
  });

  // Website-initiated signout (the account page's "Sign out" button).
  window.addEventListener("keepsake:signout", () => {
    chrome.storage.local.set({ ks_logged_out: Date.now() }, () => {
      chrome.storage.local.remove("ks_session", () => {
        window.dispatchEvent(new CustomEvent("keepsake:signout_done"));
      });
    });
  });

  // Extension logged out while this tab is open → clear the site's session here
  // too and reload, so a refresh can't sign us back in.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.ks_logged_out && changes.ks_logged_out.newValue) {
      // Only act if this tab still holds a session (e.g. extension-initiated
      // logout). Website-initiated signout already cleared localStorage, so we
      // skip the needless reload.
      const hasSession = Object.keys(localStorage).some(
        (k) => k.startsWith("sb-") && k.endsWith("-auth-token")
      );
      if (!hasSession) return;
      clearWebsiteSession();
      location.reload();
    }
  });

  // On load: if the extension is in a logged-out state, make sure this page's
  // persisted session is cleared too (covers opening the site in a fresh tab
  // after logging out in the extension).
  chrome.storage.local.get(["ks_logged_out", "ks_session"], (r) => {
    if (r.ks_logged_out && !r.ks_session) clearWebsiteSession();
  });
})();
