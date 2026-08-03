// src/lib/exportIdentity.js
//
// Export ownership: WHICH note, in WHICH view, an export belongs to — and the
// lifecycle of the one export transaction a control may have in flight.
//
// The two note views are independent export sources (see
// docs/PROJECT_DECISIONS.md → "Each note view is an independent export source").
// An export therefore never asks "which editor object exists" or "what is on
// screen now": it captures the note, the view and — for the Template form — the
// assigned template and the pinned immutable version BEFORE any asynchronous
// work begins, and everything downstream is built from that captured snapshot.
//
// Captured-snapshot rule: switching notes or views while an export is running
// lets the ORIGINAL request finish as the document that was requested. A stale
// completion may not settle the UI of a newer request, and a newer request
// supersedes the older one's status.
//
// Pure: no React, no storage, no DOM, no editor.

import { NOTE_VIEW, isNoteView, noteViewLabel } from "./noteViews";
import {
  EXPORT_BLOB_URL_MESSAGE,
  EXPORT_MISSING_ASSET_MESSAGE,
  EXPORT_UNREADABLE_ASSET_MESSAGE,
  EXPORT_UNSUPPORTED_ASSET_MESSAGE,
} from "./exportImageAssets";

export const EXPORT_STATUS = {
  IDLE: "idle",
  RUNNING: "running",
  SUCCESS: "success",
  FAILURE: "failure",
};

// Per-view failure wording. A failed export always says WHICH view failed, and
// never carries an internal exception message — that is not something a user can
// act on, and it only describes how the application is built.
export const EXPORT_FAILURE_MESSAGE = Object.freeze({
  [NOTE_VIEW.FREEFORM]: "The Free-form note could not be exported.",
  [NOTE_VIEW.TEMPLATE_FORM]: "The Template form could not be exported.",
});

export const EXPORT_GENERIC_FAILURE_MESSAGE =
  "The export could not be completed.";

export function exportFailureMessage(view) {
  return EXPORT_FAILURE_MESSAGE[view] || EXPORT_GENERIC_FAILURE_MESSAGE;
}

export function exportRunningMessage(view) {
  const label = noteViewLabel(view);
  return label ? `Exporting ${label}…` : "Exporting…";
}

export function exportSuccessMessage(view) {
  const label = noteViewLabel(view);
  return label ? `${label} exported.` : "Export complete.";
}

/** The export control's name — it always identifies the view it will export. */
export function exportControlLabel(view) {
  const label = noteViewLabel(view);
  return label ? `Export ${label}` : "Export";
}

/** A format menu item's accessible name, which also identifies its source. */
export function exportFormatLabel(view, formatName) {
  const label = noteViewLabel(view);
  const format = formatName || "file";
  return label ? `Export ${label} as ${format}` : `Export as ${format}`;
}

export const EXPORT_UNCHANGED_SUFFIX =
  "Nothing was downloaded, and the note is unchanged.";

// The Free-form exporters refuse an export whose image cannot be produced, and
// the reason is genuinely actionable. It is mapped to a short detail here so
// the status can name the VIEW that failed without repeating a second, longer
// sentence — and so an UNRECOGNIZED error can never put raw exception text on
// screen: anything not in this map degrades to the plain per-view message.
const FREEFORM_EXPORT_DETAIL = new Map([
  [
    EXPORT_MISSING_ASSET_MESSAGE,
    "One of its images is no longer in this browser's storage.",
  ],
  [
    EXPORT_UNREADABLE_ASSET_MESSAGE,
    "One of its images could not be read from storage.",
  ],
  [
    EXPORT_UNSUPPORTED_ASSET_MESSAGE,
    "One of its stored images is not a JPEG, PNG or WebP image.",
  ],
  [
    EXPORT_BLOB_URL_MESSAGE,
    "It contains a temporary image reference that is no longer valid.",
  ],
]);

export function freeformExportFailureMessage(error) {
  const detail = FREEFORM_EXPORT_DETAIL.get(error && error.message);
  const base = exportFailureMessage(NOTE_VIEW.FREEFORM);
  return detail
    ? `${base} ${detail} ${EXPORT_UNCHANGED_SUFFIX}`
    : `${base} ${EXPORT_UNCHANGED_SUFFIX}`;
}

/* ------------------------------------------------------------------------ */
/* Export identity                                                           */
/* ------------------------------------------------------------------------ */

/**
 * The complete identity of one export request.
 *
 * For the Template form the template and pinned version are part of the
 * identity: the same note re-pinned to another version is a different document,
 * even though the note id is unchanged.
 *
 * Returns null when there is nothing addressable to export.
 */
export function captureExportIdentity({
  noteId,
  view,
  templateId = null,
  templateVersionId = null,
} = {}) {
  if (!noteId || !isNoteView(view)) return null;
  if (view === NOTE_VIEW.TEMPLATE_FORM) {
    return Object.freeze({
      noteId,
      view,
      templateId: templateId ?? null,
      templateVersionId: templateVersionId ?? null,
    });
  }
  // A Free-form export has no template identity, and must never carry one —
  // that would make two Free-form exports of the same note compare unequal.
  return Object.freeze({
    noteId,
    view,
    templateId: null,
    templateVersionId: null,
  });
}

export function exportIdentityToken(identity) {
  if (!identity) return null;
  return JSON.stringify([
    identity.noteId,
    identity.view,
    identity.templateId ?? null,
    identity.templateVersionId ?? null,
  ]);
}

export function sameExportIdentity(a, b) {
  const ta = exportIdentityToken(a);
  const tb = exportIdentityToken(b);
  return !!ta && ta === tb;
}

/* ------------------------------------------------------------------------ */
/* Transaction lifecycle                                                     */
/* ------------------------------------------------------------------------ */

export function createExportState() {
  return {
    status: EXPORT_STATUS.IDLE,
    message: "",
    requestId: 0,
    identity: null,
  };
}

export function isExportRunning(state) {
  return !!state && state.status === EXPORT_STATUS.RUNNING;
}

/**
 * Begin a request. `requestId` must be a monotonic number read synchronously by
 * the caller, so two clicks inside one tick cannot both start a transaction
 * before React has re-rendered the control as disabled.
 */
export function beginExport(state, { requestId, identity }) {
  return {
    status: EXPORT_STATUS.RUNNING,
    message: exportRunningMessage(identity?.view),
    requestId,
    identity: identity || null,
  };
}

/** True only while `requestId` is still the request that owns the UI status. */
export function isCurrentExportRequest(state, requestId) {
  return !!state && state.requestId === requestId;
}

/**
 * Settle a request. A superseded request may neither report an outcome nor
 * clear the loading state of the request that replaced it.
 */
export function settleExport(state, { requestId, status, message }) {
  if (!isCurrentExportRequest(state, requestId)) return state;
  return {
    ...state,
    status,
    message: message || "",
  };
}

/** Clear a settled message without disturbing a request still in flight. */
export function clearExportMessage(state) {
  if (!state || state.status === EXPORT_STATUS.RUNNING) return state;
  if (state.status === EXPORT_STATUS.IDLE && !state.message) return state;
  return { ...createExportState(), requestId: state.requestId };
}
