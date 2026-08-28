// src/lib/assetReferences.js
//
// "Which assets does this note reference?" answered in ONE place, from the
// canonical collectors, as pure functions over stored values.
//
// This is the groundwork for reference-aware asset cleanup (a mark-and-sweep
// over live notes, live template versions and rendition sources — see
// docs/PRODUCTION_READINESS_AUDIT.md §5) and deliberately nothing more: it
// reads, it never deletes, and it is tolerant of every legacy shape a stored
// note or instance can carry. Asset references live in
//   - Free-form HTML                     `<img data-asset-id>`, `data-file-asset-id`
//   - a rendition's annotation source    `data-annotation-source-id`
//   - an instance's `attachments` / `evidence`   `{ assetId }` entries
//   - an instance's `sectionContent`             non-text items with `assetId`
//   - an instance's `sectionDoc[rowId].html`     the same HTML attributes
//   - a template version's `logoAssetId`
// A `{ assetId }` entry of ANY kind or shape counts: the cost of a false
// reference is one retained Blob; the cost of a missed one is destroyed
// evidence.

import {
  collectAnnotationSourceIdsFromHtml,
  collectAssetIdsFromHtml,
} from "./editorImageAssets";
import { FILE_ATTACHMENT_ASSET_ATTR } from "./editorFileAttachments";
import { isTextSectionItem } from "./templateSectionContent";

// The canonical file collector (`collectFileAssetIdsFromHtml`) filters by the
// shared id-shape rule, which is right for deciding what may become an editor
// node and wrong for deciding whether a Blob may be destroyed: an id of ANY
// shape sitting in the attribute protects its asset. This tolerant raw scan
// is the same rule the Template deletion gate already applies
// (templateSectionDoc.js → fileAttrReferencesId).
function collectFileAttrIdsTolerant(html) {
  const re = new RegExp(`${FILE_ATTACHMENT_ASSET_ATTR}\\s*=\\s*("([^"]*)"|'([^']*)')`, "gi");
  const ids = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    const id = (match[2] !== undefined ? match[2] : match[3] || "").trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function addAll(set, list) {
  for (const id of list || []) {
    if (typeof id === "string" && id) set.add(id);
  }
}

function addEntryAssetIds(set, map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return;
  for (const key of Object.keys(map)) {
    const list = map[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (typeof entry.assetId === "string" && entry.assetId) set.add(entry.assetId);
    }
  }
}

/** Every distinct asset id one HTML string references (images, files, and
 *  the originals of annotated renditions). Pure; malformed input → []. */
export function htmlAssetIds(html) {
  const ids = new Set();
  if (typeof html === "string" && html) {
    addAll(ids, collectAssetIdsFromHtml(html));
    addAll(ids, collectFileAttrIdsTolerant(html));
    addAll(ids, collectAnnotationSourceIdsFromHtml(html));
  }
  return Array.from(ids);
}

/** Every distinct asset id one Template instance references. Pure. */
export function instanceAssetIds(instance) {
  const ids = new Set();
  if (!instance || typeof instance !== "object") return [];
  addEntryAssetIds(ids, instance.attachments);
  addEntryAssetIds(ids, instance.evidence);

  const sections = instance.sectionContent;
  if (sections && typeof sections === "object" && !Array.isArray(sections)) {
    for (const rowId of Object.keys(sections)) {
      const list = sections[rowId];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        if (isTextSectionItem(item)) continue;
        if (typeof item.assetId === "string" && item.assetId) ids.add(item.assetId);
      }
    }
  }

  const docs = instance.sectionDoc;
  if (docs && typeof docs === "object" && !Array.isArray(docs)) {
    for (const rowId of Object.keys(docs)) {
      const doc = docs[rowId];
      const html = doc && typeof doc === "object" ? doc.html : doc;
      addAll(ids, htmlAssetIds(html));
    }
  }
  return Array.from(ids);
}

/**
 * The full manifest of one note: every asset id its Free-form content and its
 * Template instance reference, de-duplicated. Either input may be absent.
 */
export function noteAssetManifest({ html, instance } = {}) {
  const ids = new Set();
  addAll(ids, htmlAssetIds(html));
  addAll(ids, instanceAssetIds(instance));
  return Array.from(ids);
}

/** Every logo asset id any template version references. Pure. */
export function templateVersionAssetIds(versions) {
  const ids = new Set();
  if (!versions || typeof versions !== "object") return [];
  for (const id of Object.keys(versions)) {
    const logo = versions[id]?.logoAssetId;
    if (typeof logo === "string" && logo) ids.add(logo);
  }
  return Array.from(ids);
}

/**
 * The union of every live reference — the MARK set a future sweep would keep.
 * `notes` is `[{ html, instance }]`; `versions` the template-versions map;
 * `renditionSources` the `metadata.annotation.sourceAssetId` of every stored
 * rendition (an original stays alive while any rendition names it).
 */
export function liveAssetIds({ notes = [], versions = {}, renditionSources = [] } = {}) {
  const ids = new Set();
  for (const note of notes) addAll(ids, noteAssetManifest(note || {}));
  addAll(ids, templateVersionAssetIds(versions));
  addAll(ids, renditionSources);
  return ids;
}
