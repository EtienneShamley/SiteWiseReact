// src/lib/blobPreviewUrl.js
//
// A tiny, framework-agnostic manager for the ONE active object URL a preview
// surface shows at a time.
//
// Object-URL handling has to be exact: one URL per Blob, the previous URL
// revoked before a new one replaces it, and nothing left un-revoked once the
// caller is done. Rather than spreading that bookkeeping across a React effect
// (untestable here — jsdom does not implement `URL.createObjectURL`), it lives
// in this one small stateful unit with INJECTABLE create/revoke functions, so
// the lifecycle rules can be verified directly with fakes.
//
// No React, no DOM assumptions beyond the two functions it is given.

export function createBlobPreviewUrlManager({
  createObjectURL,
  revokeObjectURL,
} = {}) {
  const create =
    typeof createObjectURL === "function"
      ? createObjectURL
      : (blob) => URL.createObjectURL(blob);
  const revoke =
    typeof revokeObjectURL === "function"
      ? revokeObjectURL
      : (url) => URL.revokeObjectURL(url);

  let currentUrl = null;

  return {
    /**
     * Replace the active URL with a fresh one for `blob`.
     *
     * The PREVIOUS url is revoked first, so this manager never holds more than
     * one live URL — there is no window in which two URLs both exist. A falsy
     * `blob` just clears (see `clear()`), rather than creating a URL for
     * nothing.
     */
    set(blob) {
      if (currentUrl) {
        revoke(currentUrl);
        currentUrl = null;
      }
      if (!blob) return null;
      currentUrl = create(blob);
      return currentUrl;
    },

    /**
     * Revoke the active URL, if any, and forget it. Safe to call repeatedly —
     * a second call is a no-op, so callers never have to track whether they
     * already cleared (close-then-unmount both call this safely).
     */
    clear() {
      if (!currentUrl) return;
      revoke(currentUrl);
      currentUrl = null;
    },

    get url() {
      return currentUrl;
    },
  };
}
