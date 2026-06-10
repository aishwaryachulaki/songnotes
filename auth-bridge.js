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
//
// IMPORTANT: logout enforcement must NOT run on auth.html — that's the login
// page, and clearing the session there (e.g. during an OAuth callback) destroys
// the session being established and loops the login. On auth.html we only ever
// SAVE the session and clear the logout intent.
(function () {
  const isAuthPage = /(^|\/)auth(\.html)?(\/|$)/.test(location.pathname);

  // Remove the website's persisted Supabase session (key: sb-<ref>-auth-token).
  function clearWebsiteSession() {
    try {
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith("sb-") && k.endsWith("-auth-token")) localStorage.removeItem(k);
      });
    } catch (_) {}
  }
  function hasWebsiteSession() {
    try {
      return Object.keys(localStorage).some(
        (k) => k.startsWith("sb-") && k.endsWith("-auth-token")
      );
    } catch (_) { return false; }
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

    // A deliberate login (SIGNED_IN) OR any session arriving on the login page
    // means the user is logging in — clear the logout intent and save. We never
    // clear the website session here, so OAuth callbacks complete cleanly.
    if (detail.event === "SIGNED_IN" || isAuthPage) {
      chrome.storage.local.remove("ks_logged_out", () => saveSession(detail));
      return;
    }

    // Otherwise this is a non-login page restoring/mirroring a persisted session.
    // If the user signed out in the extension, DON'T re-sync — clear this site's
    // session too so the logout sticks.
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

  // Logout enforcement — only on non-login pages.
  if (!isAuthPage) {
    // Extension logged out while this tab is open → clear the site's session
    // here too and reload, so a refresh can't sign us back in.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.ks_logged_out && changes.ks_logged_out.newValue) {
        if (!hasWebsiteSession()) return; // nothing to clear
        clearWebsiteSession();
        location.reload();
      }
    });

    // On load, if the extension is in a logged-out state, make sure this page's
    // persisted session is cleared too (covers opening the site in a fresh tab
    // after logging out in the extension).
    chrome.storage.local.get(["ks_logged_out", "ks_session"], (r) => {
      if (r.ks_logged_out && !r.ks_session) clearWebsiteSession();
    });
  }
})();
