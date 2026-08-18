// src/lib/editorImageUrlImport.js
//
// IMAGE BY WEB ADDRESS, THE ASSET-BACKED WAY.
//
// A Template Section image is asset-backed: the bytes live in the asset store
// and the document carries only an assetId, which is what keeps exports (PDF /
// DOCX rasterize a data URL, never a network fetch), offline reading, the
// deletion gate and asset ownership consistent. A remote `src` typed into the
// toolbar's "image from a web address" control would break every one of those,
// so for a Section the address is IMPORTED:
//
//   user enters URL
//     → the shared URL policy validates it (http/https only, parsed not sniffed)
//     → the browser fetches it (CORS, no credentials, bounded time and size)
//     → the response is decided from its CONTENT: the Blob's own MIME type
//       and size go through the surface's OWN image validator (the same one
//       the local picker applies), then the shared normalize → store → insert
//       pipeline (`insertLocalImageAsset`) — so an imported image and an
//       uploaded one are byte-for-byte the same kind of asset and node.
//
// WHAT THE BROWSER ALLOWS, HONESTLY. A page may read another origin's image
// bytes only when that origin says so (CORS). Many hosts do (CDNs, object
// storage with a CORS rule, Wikimedia, image hosts); many do not. When they do
// not, the fetch fails at the network layer and NOTHING is inserted — the user
// is told to save the picture and use Upload photo instead. No fragile remote
// reference is ever stored for a Section, and no server-side proxy is
// introduced here (that would be a new fetch surface with its own SSRF policy
// — recorded as a possible follow-up, not smuggled in).
//
// The Free-form note keeps its historical remote-`src` behaviour for this
// control (src/lib/editorCommands.js → insertImageFromUrl); which behaviour the
// toolbar uses is the surface's image POLICY (`imagePolicy.importFromUrl`),
// not a second toolbar.
//
// Pure apart from `fetch`, `File` and `AbortController` — all injectable /
// standard, so the flow is unit-testable without a network.

import { normalizeImageUrl } from "./editorUrlSafety";
import { MAX_IMAGE_SOURCE_BYTES } from "./imageProcessing";
import { insertLocalImageAsset } from "./editorImageInsert";
import { validateEditorImageFile } from "./editorImages";

export const IMAGE_URL_IMPORT_TIMEOUT_MS = 20000;
export const IMAGE_URL_IMPORT_MAX_BYTES = MAX_IMAGE_SOURCE_BYTES;

export const IMAGE_URL_IMPORT_MESSAGE = Object.freeze({
  BLOCKED:
    "That image could not be imported from its web address — the site does not allow it to be downloaded here. Save the picture to this device and use Upload photo instead.",
  NOT_IMAGE: "That web address did not return an image, so nothing was inserted.",
  TOO_LARGE: "That image is too large to import, so nothing was inserted.",
  TIMEOUT: "That image took too long to download, so nothing was inserted.",
});

/** A display name for the imported file, from the URL's last path segment. */
export function imageNameFromUrl(href) {
  try {
    const url = new URL(href);
    const last = url.pathname.split("/").filter(Boolean).pop() || "";
    const decoded = decodeURIComponent(last).trim();
    return decoded || "image";
  } catch {
    return "image";
  }
}

/**
 * Fetch an image from a web address into a File, or explain why not.
 *
 * @returns {Promise<{ok: true, file: File, href: string} | {ok: false, error: string}>}
 */
export async function fetchImageFromUrl(
  rawUrl,
  { fetchImpl, maxBytes = IMAGE_URL_IMPORT_MAX_BYTES, timeoutMs = IMAGE_URL_IMPORT_TIMEOUT_MS } = {}
) {
  const url = normalizeImageUrl(rawUrl);
  if (!url.ok) return { ok: false, error: url.error };

  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { ok: false, error: IMAGE_URL_IMPORT_MESSAGE.BLOCKED };

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer =
    controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await doFetch(url.href, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      redirect: "follow",
      cache: "no-store",
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    const aborted = err && (err.name === "AbortError" || err.code === 20);
    return { ok: false, error: aborted ? IMAGE_URL_IMPORT_MESSAGE.TIMEOUT : IMAGE_URL_IMPORT_MESSAGE.BLOCKED };
  }

  if (!response || !response.ok) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: IMAGE_URL_IMPORT_MESSAGE.BLOCKED };
  }

  // A declared length is only an early refusal; the real size is measured
  // from the bytes below.
  const declared = Number(response.headers && response.headers.get && response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: IMAGE_URL_IMPORT_MESSAGE.TOO_LARGE };
  }

  let blob;
  try {
    blob = await response.blob();
  } catch (err) {
    if (timer) clearTimeout(timer);
    const aborted = err && err.name === "AbortError";
    return { ok: false, error: aborted ? IMAGE_URL_IMPORT_MESSAGE.TIMEOUT : IMAGE_URL_IMPORT_MESSAGE.BLOCKED };
  }
  if (timer) clearTimeout(timer);

  if (!blob || typeof blob.size !== "number") return { ok: false, error: IMAGE_URL_IMPORT_MESSAGE.BLOCKED };
  if (blob.size > maxBytes) return { ok: false, error: IMAGE_URL_IMPORT_MESSAGE.TOO_LARGE };
  // Decided from the content's own type — never from the URL's extension.
  const type = String(blob.type || "").toLowerCase();
  if (!type.startsWith("image/")) return { ok: false, error: IMAGE_URL_IMPORT_MESSAGE.NOT_IMAGE };

  const name = imageNameFromUrl(url.href);
  const file =
    typeof File === "function" ? new File([blob], name, { type }) : Object.assign(blob, { name });
  return { ok: true, file, href: url.href };
}

/**
 * Import an image from a web address into the editor as a normal, asset-backed
 * image node.
 *
 * `null`/`undefined` (a cancelled prompt) is not a failure: nothing happens.
 * The surface's `insertDeps` carry its own validator / asset kind, exactly as
 * the local picker's do; absent, the Free-form defaults apply.
 *
 * @returns the shared pipeline's result: `{ok: true, assetId, …}` or
 *          `{ok: false, error}` (`error` may be null for a cancel).
 */
export async function importImageFromUrl(
  { url, editor, insertDeps } = {},
  { fetchImage = fetchImageFromUrl, insert = insertLocalImageAsset } = {}
) {
  if (!editor) return { ok: false, error: null };
  if (url === null || url === undefined) return { ok: true, cancelled: true };
  if (typeof url !== "string" || !url.trim()) return { ok: true, cancelled: true };

  const fetched = await fetchImage(url);
  if (!fetched.ok) return fetched;

  // Cheap rejection through the SAME validator the pipeline applies, so a
  // response can never be accepted by one and refused by the other.
  const validate = (insertDeps && insertDeps.validate) || validateEditorImageFile;
  const check = validate(fetched.file);
  if (!check.ok) return { ok: false, error: check.error };

  return insert({ sourceFile: fetched.file, editor, name: fetched.file.name }, insertDeps || undefined);
}
