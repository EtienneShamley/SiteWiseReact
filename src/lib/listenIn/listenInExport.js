// src/lib/listenIn/listenInExport.js
//
// EXPORTING A LISTEN IN SESSION (Phase 8D.1 UI correction).
//
// A Listen In session is a first-class result, not text waiting to be dropped
// into whichever note happens to be open — so it is EXPORTED (a file the user
// gets) rather than inserted. Sharing it with a person, an email address or a
// future Inbox is a separate idea and is deliberately not mixed in here.
//
// THIS MODULE ADDS NO EXPORT STACK. Four of the five formats are produced by
// the canonical NoteWise producers, which all take the same `{ title, html }`
// shape (src/lib/exportUtils.js and src/lib/freeformExportPdf.js):
//
//   PDF   buildFreeformPdfFile({ html, noteTitle })
//   DOCX  buildFreeformDocxFile({ title, html })
//   HTML  buildFreeformHtmlFile({ title, html })
//   MD    buildFreeformMarkdownFile({ title, html })
//
// Since Phase 8D.2 the SUMMARY it carries is the session's structured one —
// an overview plus key points, decisions, action items, risks and follow-ups —
// derived ONCE by `listenInSummaryDocument` so that every format renders the
// same document. An empty section is omitted rather than printed as "None",
// an action item shows an owner or a due date only where the transcript
// actually stated one, and a summary that does not cover the whole recording
// says so in the file itself.
//
// So the whole job here is to turn a session into ONE piece of document HTML,
// and everything the rest of the application already knows about page
// geometry, Word fidelity, image resolution and Markdown conversion applies
// unchanged. The fifth format, plain text, has no canonical producer — the
// note pipeline never needed one — so `buildListenInPlainText` below is the
// smallest adapter that could serve it, and it is genuinely plain: no
// Markdown syntax, no tags, just the words laid out to be read.
//
// Pure: no React, no DOM, no network, no storage, no Blob building. The
// caller hands the strings to the producers.
import { sortBySeq, CHUNK_STATE } from "./listenInModel";
import {
  LISTEN_IN_SUMMARY_SECTION,
  LISTEN_IN_SUMMARY_SECTION_LABEL,
} from "../listenInSummaryContract";

// Local by design, as in src/lib/templateExportHtml.js: this module is the
// only place a Listen In session becomes markup, and the project deliberately
// keeps each export module's escaping beside the markup it produces rather
// than sharing one helper across pipelines that escape for different reasons.
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ============================== Choices ================================== */

/** WHAT to export. The user picks one of these before picking a format. */
export const LISTEN_IN_EXPORT_CONTENT = Object.freeze({
  SUMMARY: "summary",
  TRANSCRIPT: "transcript",
  BOTH: "both",
});

export const LISTEN_IN_EXPORT_CONTENT_ORDER = Object.freeze([
  LISTEN_IN_EXPORT_CONTENT.SUMMARY,
  LISTEN_IN_EXPORT_CONTENT.TRANSCRIPT,
  LISTEN_IN_EXPORT_CONTENT.BOTH,
]);

export const LISTEN_IN_EXPORT_CONTENT_LABEL = Object.freeze({
  [LISTEN_IN_EXPORT_CONTENT.SUMMARY]: "Summary",
  [LISTEN_IN_EXPORT_CONTENT.TRANSCRIPT]: "Transcript",
  [LISTEN_IN_EXPORT_CONTENT.BOTH]: "Summary + Transcript",
});

/**
 * The five formats, fixed as a product requirement. PDF first because it is
 * the sharing/records format; plain text and HTML last because they are the
 * plumbing ones.
 */
export const LISTEN_IN_EXPORT_FORMAT = Object.freeze({
  PDF: "pdf",
  DOCX: "docx",
  MARKDOWN: "md",
  TEXT: "txt",
  HTML: "html",
});

export const LISTEN_IN_EXPORT_FORMAT_ORDER = Object.freeze([
  LISTEN_IN_EXPORT_FORMAT.PDF,
  LISTEN_IN_EXPORT_FORMAT.DOCX,
  LISTEN_IN_EXPORT_FORMAT.MARKDOWN,
  LISTEN_IN_EXPORT_FORMAT.TEXT,
  LISTEN_IN_EXPORT_FORMAT.HTML,
]);

export const LISTEN_IN_EXPORT_FORMAT_LABEL = Object.freeze({
  [LISTEN_IN_EXPORT_FORMAT.PDF]: "PDF",
  [LISTEN_IN_EXPORT_FORMAT.DOCX]: "Word",
  [LISTEN_IN_EXPORT_FORMAT.MARKDOWN]: "Markdown",
  [LISTEN_IN_EXPORT_FORMAT.TEXT]: "Plain Text",
  [LISTEN_IN_EXPORT_FORMAT.HTML]: "HTML",
});

/** The file extension each format produces, for the one-line hint in the UI. */
export const LISTEN_IN_EXPORT_FORMAT_EXTENSION = Object.freeze({
  [LISTEN_IN_EXPORT_FORMAT.PDF]: ".pdf",
  [LISTEN_IN_EXPORT_FORMAT.DOCX]: ".docx",
  [LISTEN_IN_EXPORT_FORMAT.MARKDOWN]: ".md",
  [LISTEN_IN_EXPORT_FORMAT.TEXT]: ".txt",
  [LISTEN_IN_EXPORT_FORMAT.HTML]: ".html",
});

export function isListenInExportContent(value) {
  return LISTEN_IN_EXPORT_CONTENT_ORDER.indexOf(value) !== -1;
}

export function isListenInExportFormat(value) {
  return LISTEN_IN_EXPORT_FORMAT_ORDER.indexOf(value) !== -1;
}

export function listenInExportContentLabel(content) {
  return LISTEN_IN_EXPORT_CONTENT_LABEL[content] || "";
}

export function listenInExportFormatLabel(format) {
  return LISTEN_IN_EXPORT_FORMAT_LABEL[format] || "";
}

/* ============================== The document ============================= */

/**
 * The document's title, which also names the downloaded file. A session's own
 * title if it has one, otherwise the plain feature name — never a fabricated
 * date, and never the open note's title, because this document is not that
 * note's.
 */
export function listenInExportTitle(session) {
  const own = session && typeof session.title === "string" ? session.title.trim() : "";
  return own || "Listen In";
}

/**
 * The metadata line under the heading, built ONLY from what the session
 * actually records. A session with no stop time says nothing about one; a
 * session with no language says nothing about a language.
 */
export function listenInExportMeta(session, { formatDate = defaultFormatDate } = {}) {
  if (!session) return [];
  const lines = [];
  if (Number.isFinite(session.startedAt)) lines.push(`Started ${formatDate(session.startedAt)}`);
  if (Number.isFinite(session.stoppedAt)) lines.push(`Ended ${formatDate(session.stoppedAt)}`);
  if (session.language && session.language !== "auto") lines.push(`Language: ${session.language}`);
  return lines;
}

function defaultFormatDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

/**
 * The COMPLETE transcript, in chronological order, as paragraphs — every
 * transcribed chunk the session holds, not whatever a scroll area happened to
 * have rendered. A chunk that produced no words contributes nothing; a chunk
 * that FAILED is named in place, because a silent hole would misrepresent the
 * meeting as complete.
 */
export function listenInTranscriptParagraphs(chunks) {
  return sortBySeq(chunks)
    .map((c) => {
      if (c.state === CHUNK_STATE.TRANSCRIBED) {
        const text = String(c.text || "").trim();
        return text ? { kind: "text", text } : null;
      }
      if (c.state === CHUNK_STATE.FAILED) {
        return { kind: "gap", text: "[This part of the recording could not be transcribed.]" };
      }
      return null;
    })
    .filter(Boolean);
}

/** The summary's overview as paragraphs. Plain text with blank-line breaks. */
export function listenInSummaryParagraphs(summary) {
  const text = summary && typeof summary.text === "string" ? summary.text : "";
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * One action item as ONE readable line.
 *
 * Owner and due date appear ONLY when the transcript actually stated them
 * (src/lib/listenInSummaryContract.js normalises an absent one to null). An
 * exported document must never show a task as owned by somebody, or due on a
 * date, because a model filled a field in — so an item with neither is just
 * the task, with nothing appended.
 */
export function listenInActionItemLine(item) {
  if (!item || typeof item.task !== "string") return "";
  const task = item.task.trim();
  if (!task) return "";
  const detail = [];
  if (item.owner) detail.push(item.owner);
  if (item.dueDate) detail.push(`due ${item.dueDate}`);
  return detail.length ? `${task} (${detail.join(", ")})` : task;
}

/**
 * A session's summary as an ORDERED DOCUMENT: the overview, then each
 * structured section that actually has content, then — when the summary does
 * not cover the whole recording — the one sentence that says so.
 *
 * One derivation for every format, so the PDF, the Word document, the
 * Markdown, the HTML and the plain text cannot disagree about what the summary
 * contains. An empty section is OMITTED rather than printed as "None": a
 * heading with nothing under it reads as a finding, and there was none.
 *
 * The `summary` it takes is the presentation shape the window builds
 * (`{ text, result, note }`); the older `{ text }` shape still works and
 * simply produces the overview alone.
 */
export function listenInSummaryDocument(summary) {
  const result = summary && summary.result ? summary.result : null;
  const sections = [];
  if (result) {
    for (const key of [
      LISTEN_IN_SUMMARY_SECTION.KEY_POINTS,
      LISTEN_IN_SUMMARY_SECTION.DECISIONS,
      LISTEN_IN_SUMMARY_SECTION.ACTION_ITEMS,
      LISTEN_IN_SUMMARY_SECTION.RISKS,
      LISTEN_IN_SUMMARY_SECTION.FOLLOW_UPS,
    ]) {
      const raw = Array.isArray(result[key]) ? result[key] : [];
      const items =
        key === LISTEN_IN_SUMMARY_SECTION.ACTION_ITEMS
          ? raw.map(listenInActionItemLine).filter(Boolean)
          : raw.map((v) => String(v || "").trim()).filter(Boolean);
      if (items.length) sections.push({ key, heading: LISTEN_IN_SUMMARY_SECTION_LABEL[key], items });
    }
  }
  return {
    paragraphs: listenInSummaryParagraphs(summary),
    sections,
    // Stated plainly in the document itself, not only on screen: a file that
    // looks like a complete record of a meeting must say when it is not.
    note: summary && typeof summary.note === "string" ? summary.note.trim() : "",
  };
}

/** Whether a summary holds anything a file could carry. */
export function hasListenInSummaryDocument(summary) {
  const doc = listenInSummaryDocument(summary);
  return doc.paragraphs.length > 0 || doc.sections.length > 0;
}

function sectionsFor(content) {
  switch (content) {
    case LISTEN_IN_EXPORT_CONTENT.SUMMARY:
      return { summary: true, transcript: false };
    case LISTEN_IN_EXPORT_CONTENT.TRANSCRIPT:
      return { summary: false, transcript: true };
    default:
      return { summary: true, transcript: true };
  }
}

/**
 * ONE piece of document HTML for the chosen content — the input every
 * canonical producer takes. Headings and paragraphs only: no stylesheet, no
 * classes, nothing the PDF planner, the Word preparation or the Markdown
 * converter has to be taught about. Summary always precedes Transcript.
 */
export function buildListenInExportHtml({
  session,
  chunks = [],
  summary = null,
  content = LISTEN_IN_EXPORT_CONTENT.BOTH,
  formatDate,
} = {}) {
  const want = sectionsFor(content);
  const parts = [`<h1>${escapeHtml(listenInExportTitle(session))}</h1>`];
  const meta = listenInExportMeta(session, formatDate ? { formatDate } : undefined);
  if (meta.length) parts.push(`<p>${meta.map(escapeHtml).join("<br />")}</p>`);

  if (want.summary) {
    parts.push("<h2>Summary</h2>");
    const doc = listenInSummaryDocument(summary);
    if (doc.note) parts.push(`<p><em>${escapeHtml(doc.note)}</em></p>`);
    if (doc.paragraphs.length === 0 && doc.sections.length === 0) {
      parts.push("<p>No summary has been generated for this session.</p>");
    } else {
      for (const p of doc.paragraphs) {
        // The overview may still arrive with "- " bullet lines; keep them as a
        // real list so Word, PDF and Markdown each render a list rather than a
        // paragraph that happens to start with a hyphen.
        const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length > 1 && lines.every((l) => /^[-*•]\s+/.test(l))) {
          parts.push(
            `<ul>${lines.map((l) => `<li>${escapeHtml(l.replace(/^[-*•]\s+/, ""))}</li>`).join("")}</ul>`
          );
        } else {
          parts.push(`<p>${lines.map(escapeHtml).join("<br />")}</p>`);
        }
      }
      // The structured sections, in the order the contract defines them.
      for (const section of doc.sections) {
        parts.push(`<h3>${escapeHtml(section.heading)}</h3>`);
        parts.push(`<ul>${section.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`);
      }
    }
  }

  if (want.transcript) {
    parts.push("<h2>Transcript</h2>");
    const paragraphs = listenInTranscriptParagraphs(chunks);
    if (paragraphs.length === 0) {
      parts.push("<p>No speech was transcribed for this session.</p>");
    } else {
      for (const p of paragraphs) {
        parts.push(
          p.kind === "gap"
            ? `<p><em>${escapeHtml(p.text)}</em></p>`
            : `<p>${escapeHtml(p.text)}</p>`
        );
      }
    }
  }

  return parts.join("\n");
}

/**
 * The same document as genuinely PLAIN text — the one format the canonical
 * producers do not cover, because the note pipeline never needed one. No
 * Markdown syntax and no tags: headings are their own lines over a rule, and
 * bullets keep a leading "- " only because that is how a list reads in a text
 * file.
 */
export function buildListenInPlainText({
  session,
  chunks = [],
  summary = null,
  content = LISTEN_IN_EXPORT_CONTENT.BOTH,
  formatDate,
} = {}) {
  const want = sectionsFor(content);
  const title = listenInExportTitle(session);
  const out = [title, "=".repeat(title.length)];
  const meta = listenInExportMeta(session, formatDate ? { formatDate } : undefined);
  if (meta.length) out.push("", ...meta);

  if (want.summary) {
    out.push("", "Summary", "-------");
    const doc = listenInSummaryDocument(summary);
    if (doc.note) out.push("", doc.note);
    if (doc.paragraphs.length === 0 && doc.sections.length === 0) {
      out.push("", "No summary has been generated for this session.");
    } else {
      for (const p of doc.paragraphs) out.push("", p);
      for (const section of doc.sections) {
        out.push("", section.heading, "-".repeat(section.heading.length));
        for (const item of section.items) out.push(`- ${item}`);
      }
    }
  }

  if (want.transcript) {
    out.push("", "Transcript", "----------");
    const paragraphs = listenInTranscriptParagraphs(chunks);
    if (paragraphs.length === 0) out.push("", "No speech was transcribed for this session.");
    else for (const p of paragraphs) out.push("", p.text);
  }

  return `${out.join("\n").trim()}\n`;
}
