// src/lib/exportImageDecode.js
//
// One image's real pixel dimensions, read from an already-resolved data URL.
//
// Moved here unchanged from the Template PDF runner so BOTH exporters share it:
// an image whose dimensions are unknown renders as `height: auto` and measures
// as very nearly nothing until the browser has decoded it, so the page plan is
// built from a short height and the decoded image then overflows the space it
// was given. Resolving the size up front makes a block's height deterministic
// and independent of decode timing.
//
// Never rejects and never waits indefinitely: an image that cannot be decoded
// resolves to `null`, and the caller keeps its CSS `max-height` behaviour, which
// scales down and still cannot crop.
//
// Everything here is a local data URL — no network is involved — so the timeout
// only bounds a pathological decode, never a request.

export const IMAGE_DECODE_TIMEOUT_MS = 5000;

export function decodeImageSize(dataUrl, timeoutMs = IMAGE_DECODE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      const img = new Image();
      img.onload = () =>
        done(
          img.naturalWidth > 0 && img.naturalHeight > 0
            ? { width: img.naturalWidth, height: img.naturalHeight }
            : null
        );
      img.onerror = () => done(null);
      timer = setTimeout(() => done(null), timeoutMs);
      img.src = dataUrl;
    } catch {
      done(null);
    }
  });
}

/**
 * Decode a set of distinct sources ONCE each and return a `src -> size` map.
 *
 * The cache is per call, i.e. per export: nothing is remembered across exports
 * and nothing is written back to storage — this is a measurement detail of one
 * document, not a data migration.
 */
export async function decodeImageSizes(sources, deps = {}) {
  const decode = deps.decode || decodeImageSize;
  const sizes = new Map();
  const unique = [];
  for (const src of sources || []) {
    if (typeof src !== "string" || !src) continue;
    if (sizes.has(src)) continue;
    sizes.set(src, null);
    unique.push(src);
  }
  for (const src of unique) sizes.set(src, await decode(src));
  return sizes;
}
