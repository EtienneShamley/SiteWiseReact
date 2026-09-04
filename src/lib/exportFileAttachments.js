// src/lib/exportFileAttachments.js
//
// Export-time resolution of Free-form FILE attachments.
//
// A note stores an attachment as `<div data-file-asset-id="…">` because the
// bytes live in IndexedDB. An exported document cannot carry those bytes, so
// every export format replaces the node with an honest static reference:
//
//     Q3 Report.docx
//     Word · 180 KB — Attached file, not included in this export.
//
// It says so explicitly rather than showing a filename that looks like a link
// and is not — an export that implies it contains a file it does not contain is
// worse than one that admits the omission.
//
// Unlike images (src/lib/exportImageAssets.js) a missing attachment does NOT
// fail the export. An image is content that would silently vanish from the
// page; an attachment is a reference either way, so an unavailable one is
// reported in place and the rest of the document is still produced.
//
// Everything happens on a DETACHED copy: the input string is parsed into an
// inert document and a NEW string is returned. The editor, the stored note HTML
// and the stored assets are never touched.
//
// Also neutralized here: legacy `blob:` anchors left in stored note HTML by the
// previous temporary-link path. Their bytes are not recoverable, and a dead
// `blob:` URL must never reach an exported file. The stored note is not
// rewritten — only the export copy.

import { ASSET_KIND_EDITOR_FILE } from "./assetStorage";
import { ASSET_READ_STATE, readAssetWithState, readerFromLoadAsset } from "./assetReader";
import {
  EXPORT_ATTACHMENT_NOTE,
  EXPORT_ATTACHMENT_NOT_ON_DEVICE_NOTE,
  EXPORT_ATTACHMENT_UNAVAILABLE_NOTE,
  FILE_ATTACHMENT_ASSET_ATTR,
  FILE_ATTACHMENT_NAME_ATTR,
  LEGACY_LINK_UNAVAILABLE_SUFFIX,
  fileAttachmentAttrsFromElement,
  fileAttachmentMetaText,
  isBlobUrl,
} from "./editorFileAttachments";
import { safeDownloadFilename } from "./safeAttachmentOpen";

export const EXPORT_ATTACHMENT_CLASS = "note-file-attachment-export";
export const EXPORT_UNNAMED_ATTACHMENT = "Attached file";

// A detached document: parsing here loads no resources and runs no script.
function defaultParseHtml(html) {
  const doc = document.implementation.createHTMLDocument("");
  const container = doc.createElement("div");
  container.innerHTML = html;
  return container;
}

/**
 * Replace every file-attachment node in `html` with a static, honest reference,
 * and neutralize any surviving legacy `blob:` anchor.
 *
 * Each distinct asset id is read EXACTLY ONCE per call, however many times the
 * note references it.
 *
 * @returns {Promise<string>} export-only HTML
 */
export async function resolveExportFileAttachmentHtml(html, deps = {}) {
  const {
    // An injected `loadAsset` keeps its Phase 7.2 shape and is adapted, so a
    // caller that only knows "record or nothing" behaves exactly as before.
    loadAsset = null,
    readAsset = loadAsset ? readerFromLoadAsset(loadAsset) : readAssetWithState,
    parseHtml = defaultParseHtml,
  } = deps;

  if (typeof html !== "string" || !html) return "";
  const hasAttachments = html.includes(FILE_ATTACHMENT_ASSET_ATTR);
  const hasBlobUrl = /blob:/i.test(html);
  if (!hasAttachments && !hasBlobUrl) return html;

  const container = parseHtml(html);
  const doc = container.ownerDocument || document;

  // 1. Legacy temporary links. The filename TEXT is kept — deleting the user's
  //    own content would be worse — but the dead href is removed and the state
  //    is stated plainly. Nothing here claims the bytes are recoverable.
  for (const anchor of Array.from(container.querySelectorAll("a[href]"))) {
    if (!isBlobUrl(anchor.getAttribute("href"))) continue;
    anchor.removeAttribute("href");
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
    const label = (anchor.textContent || "").trim();
    // textContent, never innerHTML: the label is data, not markup.
    anchor.textContent = `${label || EXPORT_UNNAMED_ATTACHMENT}${LEGACY_LINK_UNAVAILABLE_SUFFIX}`;
  }

  if (!hasAttachments) return container.innerHTML;

  const nodes = Array.from(
    container.querySelectorAll(`[${FILE_ATTACHMENT_ASSET_ATTR}]`)
  );
  if (nodes.length === 0) return container.innerHTML;

  // 2. Read each referenced asset once. Authoritative metadata is preferred;
  //    the serialized values only label an attachment that cannot be retrieved.
  const ids = [];
  for (const node of nodes) {
    const id = fileAttachmentAttrsFromElement(node).assetId;
    if (id && !ids.includes(id)) ids.push(id);
  }

  const resolved = new Map();
  // Assets whose bytes exist but have not reached this device. A tolerant
  // export still omits them — it never embeds a binary — but it must not tell
  // the reader the file is unavailable when it is merely elsewhere.
  const notOnDevice = new Set();
  for (const id of ids) {
    let read = null;
    try {
      read = await readAsset(id);
    } catch {
      read = null;
    }
    if (
      read &&
      (read.state === ASSET_READ_STATE.PENDING || read.state === ASSET_READ_STATE.OFFLINE)
    ) {
      notOnDevice.add(id);
    }
    const asset = read && read.state === ASSET_READ_STATE.READY ? read.record : null;
    // The kind is checked here too: an export must not describe a Template-form
    // File or an editor image as though it were this note's attachment.
    if (
      asset &&
      asset.blob &&
      asset.kind === ASSET_KIND_EDITOR_FILE &&
      typeof asset.blob.size === "number"
    ) {
      resolved.set(id, {
        name: safeDownloadFilename(asset.name),
        mimeType: asset.blob.type || null,
        size: asset.blob.size,
      });
    }
  }

  // 3. Replace each node with a static block. The asset id is deliberately NOT
  //    carried into the export: it is an internal storage identifier that means
  //    nothing outside this browser.
  for (const node of nodes) {
    const stored = fileAttachmentAttrsFromElement(node);
    const authoritative = stored.assetId ? resolved.get(stored.assetId) : null;
    const available = !!authoritative;

    const name =
      (authoritative && authoritative.name) ||
      stored.name ||
      // Fall back to whatever readable name the serialized form carries.
      safeDownloadFilename(node.getAttribute(FILE_ATTACHMENT_NAME_ATTR)) ||
      EXPORT_UNNAMED_ATTACHMENT;
    const mimeType = available ? authoritative.mimeType : stored.mimeType;
    const size = available ? authoritative.size : stored.size;

    const block = doc.createElement("div");
    block.setAttribute("class", EXPORT_ATTACHMENT_CLASS);

    const strong = doc.createElement("strong");
    strong.textContent = name;
    block.appendChild(strong);

    const meta = doc.createElement("span");
    const pendingElsewhere = stored.assetId ? notOnDevice.has(stored.assetId) : false;
    const metaText = available
      ? ` — ${fileAttachmentMetaText(mimeType, name, size)} — ${EXPORT_ATTACHMENT_NOTE}`
      : ` — ${pendingElsewhere ? EXPORT_ATTACHMENT_NOT_ON_DEVICE_NOTE : EXPORT_ATTACHMENT_UNAVAILABLE_NOTE}`;
    meta.textContent = metaText;
    block.appendChild(meta);

    node.replaceWith(block);
  }

  return container.innerHTML;
}
