// src/lib/templateSectionOpeningParity.test.js
//
// WHAT A TEMPLATE SECTION'S DOCUMENT BEGINS WITH, AND WHAT CAN BE PRESSED TO
// OPEN IT — the two interaction/read-parity rules the Phase G correction fixed.
//
//   1. A Section whose only content is a FILE is directly activatable. Its card
//      surface presses through to the shared editor, and its OWN controls (Open
//      / Preview, Download, the text-preview dialog) are never hijacked to do
//      it. Before the correction a file-only Section under a structured row had
//      no press target at all.
//
//   2. A legacy Text row whose answer says NOTHING and whose body is its
//      EVIDENCE begins with that evidence. Before the correction the adapter
//      manufactured a paragraph to represent the absent answer, so such a row
//      rendered a blank line and an "Enter details…" prompt above its picture.
//      A genuinely empty Section still opens as one typeable empty document.
//
// Both are proved where they are decided: the press rule is a pure DOM
// predicate and is exercised against real elements; the document's opening
// content is the canonical reader's, and is exercised through it. Source-text
// assertions appear only for the wiring a component owns (this project's Jest
// cannot import `@tiptap/react`, so a Template component cannot be rendered
// here — the same constraint every other Template wiring suite works under).

import fs from "fs";
import path from "path";

import {
  SECTION_MEDIA_CONTROL_SELECTOR,
  pressIsOnMediaControl,
} from "./templateSectionMediaPress";
import {
  SECTION_BODY_SOURCE,
  SECTION_EDITOR_REFUSAL,
  SECTION_QUICK_ADD_ROUTE,
  isLegacyMediaBody,
  isSectionDocumentBody,
  resolveSectionBody,
  resolveSectionQuickAddRoute,
  sectionBodyHtml,
  sectionEditorEligibility,
} from "./templateSectionBody";
import { adaptLegacyBodyToNodes } from "./templateSectionDocAdapter";
import {
  SECTION_DOC_FORMAT,
  SECTION_DOC_NODE,
  parseSectionDocHtml,
  sectionDocAssetIds,
  sectionDocHtmlFromNodes,
} from "./templateSectionDoc";
import {
  SECTION_SEGMENT_KIND,
  sectionDocSegments,
} from "./templateSectionDocSegments";
import { ROW_BLOCK_KIND, planRowBlocks } from "./templateRowContent";
import { FILE_ATTACHMENT_CLASS } from "./editorFileAttachments";
import {
  isAttachmentAssetReferenced,
  saveNoteTemplateInstanceOrThrow,
} from "./templateModel";

const SRC = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const TABLE = read("components/template/ResizableTwoColTable.js");
const DOC_VIEW = read("components/template/TemplateSectionDocView.js");
const CARD = read("components/editor/fileAttachmentPresentation.js");
const NODE_VIEW = read("components/editor/FileAttachment.js");
const EXTENSIONS = read("components/editor/sectionEditorExtensions.js");
const CSS = read("components/template/template.css");
const between = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to));

const ROW = "row-1";
const FILE_ASSET = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PHOTO_ASSET = "8f0e2c1a-4b6d-4e2f-9a1b-3c5d7e9f0a1b";
// The historical migrated-attachment id shape: refused by the shared file
// serializer (Phase G0 — it guards hand-edited / foreign storage only).
const LONG_FILE_ASSET = "note-att-root-note-1712345678901-project_name-0";

const photoEvidence = ({ id = "e-photo", assetId = PHOTO_ASSET } = {}) => ({
  id,
  kind: "photo",
  assetId,
  name: "site.jpg",
  mimeType: "image/jpeg",
  size: 2048,
  intrinsicWidth: 800,
  intrinsicHeight: 600,
  display: { widthPct: 60, alignment: "left" },
});
const fileEvidence = ({ id = "e-file", assetId = FILE_ASSET } = {}) => ({
  id,
  kind: "file",
  assetId,
  name: "report.pdf",
  mimeType: "application/pdf",
  size: 4096,
});
const textItem = (id, value) => ({ id, kind: "text", value });

const instanceWith = (over = {}) => ({
  noteId: "note-1",
  templateId: "tpl-1",
  templateVersionId: "ver-1",
  answers: {},
  attachments: {},
  evidence: {},
  sectionContent: {},
  customRows: [],
  ...over,
});

/** A modern `sectionDoc` entry holding EXACTLY one file node and nothing else. */
function fileOnlyDoc(assetId = FILE_ASSET) {
  const html = sectionDocHtmlFromNodes([
    {
      type: SECTION_DOC_NODE.FILE,
      attrs: {
        assetId,
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 4096,
      },
    },
  ]);
  return { format: SECTION_DOC_FORMAT, html };
}

const bodyOf = (instance, extra = {}) =>
  resolveSectionBody({ instance, rowId: ROW, rowType: "text", ...extra });

/* ======================================================================== */
/* 1. A FILE-ONLY SECTION IS ACTIVATABLE                                    */
/* ======================================================================== */

describe("1. a file-only Section is directly activatable", () => {
  test("1. an eligible file-only modern Section resolves to ONE file segment the surface can press", () => {
    const body = bodyOf(instanceWith({ sectionDoc: { [ROW]: fileOnlyDoc() } }));
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(isSectionDocumentBody(body)).toBe(true);
    expect(sectionEditorEligibility(body)).toEqual({ ok: true });
    expect(body.nodes.map((n) => n.type)).toEqual([SECTION_DOC_NODE.FILE]);

    // The layout projection gives exactly one FILE segment — the thing the
    // surface renders and now presses through.
    const segments = sectionDocSegments(body);
    expect(segments.map((s) => s.kind)).toEqual([SECTION_SEGMENT_KIND.FILE]);

    // …and `renderSectionDocMedia` treats a FILE segment as a press target,
    // exactly as it treats an IMAGE one.
    const media = between(
      TABLE,
      "function renderSectionDocMedia(row, segment)",
      "function renderSectionDocSegmentBody(row, segment)"
    );
    expect(media).toContain("segment.kind === SECTION_SEGMENT_KIND.IMAGE");
    expect(media).toContain("segment.kind === SECTION_SEGMENT_KIND.FILE");
    expect(media).toContain("twocol-section-media--pressable");
    expect(media).toContain("activateSectionEditor(row, event);");
    // Only for a row the shared editor may own.
    expect(media).toContain("if (!sectionEditorOwnsRow(row) || !isMedia) return view;");
    // Every FILE segment goes through it, wherever it sits in the row.
    const segmentBody = between(
      TABLE,
      "function renderSectionDocSegmentBody(row, segment)",
      "function renderCompatSegmentBody(row, segment)"
    );
    expect(segmentBody).toContain("return renderSectionDocMedia(row, segment);");
    expect(CSS).toContain(".twocol-section-media--pressable {");
    // A card is not text: the pointer must not promise a caret.
    expect(CSS).toContain(".twocol-section-media--card {");
  });

  test("1b. a file-HEADED Section also keeps its keyboard lead-in, so the pointer route is additive", () => {
    const body = bodyOf(instanceWith({ sectionDoc: { [ROW]: fileOnlyDoc() } }));
    const blocks = planRowBlocks({
      row: { id: ROW, label: "Attachments", type: "text", px: 120 },
      sectionSegments: sectionDocSegments(body),
    });
    // A Text row hands its whole body over, so the FILE segment IS the head.
    expect(blocks.map((b) => b.kind)).toEqual([ROW_BLOCK_KIND.SECTION_SEGMENT]);
    expect(blocks[0].isRowHead).toBe(true);
    expect(blocks[0].sectionSegment.kind).toBe(SECTION_SEGMENT_KIND.FILE);
    // The head slot of a media-headed OWNED Section is the zero-height lead-in
    // (role=button, Enter/Space) — the accessible activation route.
    expect(TABLE).toContain("if (sectionEditorOwnsRow(row)) return renderSectionEditorLeadIn(row);");
    const leadIn = between(
      TABLE,
      "function renderSectionEditorLeadIn(row)",
      "function renderSectionStaticAnswer(row, value)"
    );
    expect(leadIn).toContain('role="button"');
    expect(leadIn).toContain("tabIndex={0}");
    expect(leadIn).toContain('if (e.key !== "Enter" && e.key !== " ") return;');
  });

  test("2. activation writes NOTHING — the press handler only activates", () => {
    const media = between(
      TABLE,
      "function renderSectionDocMedia(row, segment)",
      "function renderSectionDocSegmentBody(row, segment)"
    );
    for (const writer of [
      "persistSectionDoc",
      "saveInstanceConfirmed",
      "setInstance",
      "sectionContent",
      "deleteAsset",
    ]) {
      expect(media).not.toContain(writer);
    }
    // Activation itself supplies the document at CONSTRUCTION, which is why
    // opening a Section emits no update and writes nothing.
    const factory = read("components/template/sectionEditorFactory.js");
    expect(factory).toContain('content: typeof html === "string" ? html : ""');
    const activate = between(
      TABLE,
      "function activateSectionEditor(row, event)",
      "function renderSectionEditor(row)"
    );
    expect(activate).toContain("sectionEditor.onActivate(row.id)");
    expect(activate).not.toContain("persist");
  });

  test("3. the file's stored assetId is carried EXACTLY — never re-minted, never truncated", () => {
    const html = fileOnlyDoc().html;
    expect(html).toContain(FILE_ASSET);
    // The document the editor opens with round-trips to the same node and id.
    const body = bodyOf(instanceWith({ sectionDoc: { [ROW]: { format: SECTION_DOC_FORMAT, html } } }));
    expect(body.nodes[0].attrs.assetId).toBe(FILE_ASSET);
    expect(sectionBodyHtml(body)).toBe(html);
    expect(parseSectionDocHtml(sectionBodyHtml(body))[0].attrs.assetId).toBe(FILE_ASSET);
    // The deletion gate sees it through the same document.
    expect(sectionDocAssetIds(html).fileIds).toEqual([FILE_ASSET]);
  });

  test("3b. and the asset stays protected while the file-only document names it", () => {
    localStorage.clear();
    saveNoteTemplateInstanceOrThrow(instanceWith({ sectionDoc: { [ROW]: fileOnlyDoc() } }));
    expect(isAttachmentAssetReferenced(FILE_ASSET)).toBe(true);
    expect(isAttachmentAssetReferenced("asset-nothing-references-this")).toBe(false);
  });

  test("4. a press on the file card's OWN controls is not stolen by activation", () => {
    // A real card's structure, built the way the shared card builds it.
    const wrapper = document.createElement("div");
    wrapper.className = "twocol-section-media twocol-section-media--pressable";
    wrapper.innerHTML = `
      <div class="${FILE_ATTACHMENT_CLASS}">
        <div class="${FILE_ATTACHMENT_CLASS}__body">
          <span class="${FILE_ATTACHMENT_CLASS}__name">report.pdf</span>
          <span class="${FILE_ATTACHMENT_CLASS}__meta">PDF · 4 KB</span>
        </div>
        <div class="${FILE_ATTACHMENT_CLASS}__actions" contenteditable="false">
          <button type="button" class="${FILE_ATTACHMENT_CLASS}__btn"><span>Open</span></button>
          <button type="button" class="${FILE_ATTACHMENT_CLASS}__btn">Download</button>
        </div>
        <p class="${FILE_ATTACHMENT_CLASS}__error" role="alert">Could not open.</p>
      </div>`;
    document.body.appendChild(wrapper);
    const q = (sel) => wrapper.querySelector(sel);

    // CONTROLS — left entirely alone.
    const open = q(`.${FILE_ATTACHMENT_CLASS}__actions button`);
    expect(pressIsOnMediaControl({ target: open })).toBe(true);
    // …including a press on a label INSIDE the button.
    expect(pressIsOnMediaControl({ target: open.querySelector("span") })).toBe(true);
    expect(pressIsOnMediaControl({ target: q(`.${FILE_ATTACHMENT_CLASS}__actions`) })).toBe(true);
    // A future control added to the actions strip is excluded by default.
    const futureControl = document.createElement("span");
    q(`.${FILE_ATTACHMENT_CLASS}__actions`).appendChild(futureControl);
    expect(pressIsOnMediaControl({ target: futureControl })).toBe(true);

    // CARD SURFACE — an ordinary press that activates the Section.
    expect(pressIsOnMediaControl({ target: q(`.${FILE_ATTACHMENT_CLASS}__name`) })).toBe(false);
    expect(pressIsOnMediaControl({ target: q(`.${FILE_ATTACHMENT_CLASS}__meta`) })).toBe(false);
    expect(pressIsOnMediaControl({ target: q(`.${FILE_ATTACHMENT_CLASS}__body`) })).toBe(false);
    expect(pressIsOnMediaControl({ target: q(`.${FILE_ATTACHMENT_CLASS}`) })).toBe(false);
    expect(pressIsOnMediaControl({ target: wrapper })).toBe(false);
    // The card's live region is not a control either — pressing it is a press on
    // the card, which is the harmless answer.
    expect(pressIsOnMediaControl({ target: q(`.${FILE_ATTACHMENT_CLASS}__error`) })).toBe(false);

    document.body.removeChild(wrapper);
  });

  test("4b. the text-preview DIALOG the card can open is not an activation target", () => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div class="${FILE_ATTACHMENT_CLASS}">
        <div role="dialog" aria-modal="true">
          <p>the file's text</p>
          <button type="button">Close</button>
        </div>
      </div>`;
    document.body.appendChild(wrapper);
    expect(pressIsOnMediaControl({ target: wrapper.querySelector("p") })).toBe(true);
    expect(pressIsOnMediaControl({ target: wrapper.querySelector("button") })).toBe(true);
    document.body.removeChild(wrapper);
    // The dialog really is rendered inside the card.
    expect(CARD).toContain("<TextPreviewDialog");
    expect(read("components/template/TextPreviewDialog.js")).toContain('role="dialog"');
  });

  test("4c. a control press is left alone — NOT prevented — so its click still fires", () => {
    const media = between(
      TABLE,
      "function renderSectionDocMedia(row, segment)",
      "function renderSectionDocSegmentBody(row, segment)"
    );
    // The guard returns BEFORE preventDefault: suppressing the default is
    // exactly what would stop the control receiving its click.
    const handler = between(media, "onMouseDown={(event) => {", "}}");
    const guardAt = handler.indexOf("if (pressIsOnMediaControl(event)) return;");
    const preventAt = handler.indexOf("event.preventDefault();");
    expect(guardAt).toBeGreaterThan(-1);
    expect(preventAt).toBeGreaterThan(guardAt);
    expect(handler.indexOf("activateSectionEditor")).toBeGreaterThan(guardAt);
    // Nothing defensive is needed of a malformed press.
    expect(pressIsOnMediaControl(undefined)).toBe(false);
    expect(pressIsOnMediaControl({})).toBe(false);
    expect(pressIsOnMediaControl({ target: {} })).toBe(false);
    expect(SECTION_MEDIA_CONTROL_SELECTOR).toContain("button");
    expect(SECTION_MEDIA_CONTROL_SELECTOR).toContain(`.${FILE_ATTACHMENT_CLASS}__actions`);
  });

  test("5. Remove and undo stay the SHARED editor's — the static card has no remover", () => {
    // Static: the same shared card, deliberately with no `onRemove`, so a
    // read-only rendering cannot delete anything.
    expect(DOC_VIEW).toContain("useFileAttachmentCard({");
    const staticFile = between(DOC_VIEW, "function SectionDocFile({ attrs })", "/**");
    expect(staticFile).not.toContain("onRemove");
    // Active: the shared NodeView's Remove is `deleteNode()` — one editor
    // transaction, therefore one undo step — and it deletes no Blob.
    expect(NODE_VIEW).toContain("onRemove");
    expect(NODE_VIEW).toContain("deleteNode");
    expect(NODE_VIEW).not.toContain("deleteAsset");
    // There is ONE file renderer: the Template surface has no second card.
    expect(TABLE).not.toContain("useFileAttachmentCard");
    expect(CARD).toContain(`export function useFileAttachmentCard`);
    // The Section's editor installs that same shared node, for the Template's
    // own asset kind.
    expect(EXTENSIONS).toContain("FileAttachment.extend({ group: SECTION_MEDIA_GROUP }).configure({");
    expect(EXTENSIONS).toContain("SECTION_FILE_ASSET_KINDS");
  });

  test("6. a structured row's PRIMARY value stays outside the Section document", () => {
    const instance = instanceWith({
      answers: { [ROW]: "READING-4-2-MM" },
      sectionDoc: { [ROW]: fileOnlyDoc() },
    });
    const body = resolveSectionBody({ instance, rowId: ROW, rowType: "number" });
    // The document is the file and nothing else — the typed value is not in it,
    // and there is no prose node at all for it to have entered.
    expect(body.nodes.map((n) => n.type)).toEqual([SECTION_DOC_NODE.FILE]);
    expect(sectionBodyHtml(body)).not.toContain("READING-4-2-MM");
    expect(sectionBodyHtml(body)).not.toContain("<p");
    // …and the typed value stays exactly where its control reads it.
    expect(instance.answers[ROW]).toBe("READING-4-2-MM");
    // …and the row still emits its own typed control FIRST.
    const blocks = planRowBlocks({
      row: { id: ROW, label: "Readings", type: "number", px: 60 },
      sectionSegments: sectionDocSegments(body),
    });
    expect(blocks.map((b) => b.kind)).toEqual([
      ROW_BLOCK_KIND.ROW,
      ROW_BLOCK_KIND.SECTION_SEGMENT,
    ]);
    expect(blocks[1].isRowHead).toBe(false);
    // Before the correction this row had NO press target at all: its only
    // segment is a file card, and only IMAGE segments were pressable.
    expect(sectionDocSegments(body).map((s) => s.kind)).toEqual([SECTION_SEGMENT_KIND.FILE]);
  });

  test("7. a refused row stays NON-modern: no activation, no Quick Add, read-only", () => {
    // A file the shared serializer will not carry (a historical migrated id).
    const body = bodyOf(
      instanceWith({
        sectionContent: {
          [ROW]: [textItem("t1", "kept"), fileEvidence({ id: "f1", assetId: LONG_FILE_ASSET })],
        },
      })
    );
    expect(sectionEditorEligibility(body)).toEqual({
      ok: false,
      reason: SECTION_EDITOR_REFUSAL.UNREPRESENTABLE,
    });
    expect(resolveSectionQuickAddRoute(body)).toBe(SECTION_QUICK_ADD_ROUTE.REFUSE);
    // It is still fully visible, in stored position, with its exact id.
    const segments = sectionDocSegments(body);
    expect(segments.map((s) => s.kind)).toEqual([
      SECTION_SEGMENT_KIND.TEXT,
      SECTION_SEGMENT_KIND.COMPAT,
    ]);
    expect(segments[1].entry.assetId).toBe(LONG_FILE_ASSET);
    // …and nothing about a refused row is pressable: both the prose renderer and
    // the media renderer require `sectionEditorOwnsRow`.
    const docText = between(
      TABLE,
      "function renderSectionDocText(row, segment",
      "function renderSectionDocMedia(row, segment)"
    );
    expect(docText).toContain('if (!sectionEditorOwnsRow(row)) {');
    const media = between(
      TABLE,
      "function renderSectionDocMedia(row, segment)",
      "function renderSectionDocSegmentBody(row, segment)"
    );
    expect(media).toContain("if (!sectionEditorOwnsRow(row) || !isMedia) return view;");
    // A compat segment is rendered by the read-only compatibility renderer.
    const compat = between(
      TABLE,
      "function renderCompatSegmentBody(row, segment)",
      "function renderSectionDocSegment(row, segment, ctx, section = null)"
    );
    expect(compat).toContain("readOnly");
    expect(compat).not.toContain("onRemove");
  });
});

/* ======================================================================== */
/* 2. WHAT AN ADAPTED DOCUMENT BEGINS WITH                                  */
/* ======================================================================== */

describe("2. what a Section's adapted document begins with", () => {
  test("A. no body / a truly empty Section is still ONE typeable empty document", () => {
    const body = bodyOf(instanceWith({}));
    expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
    expect(sectionEditorEligibility(body)).toEqual({ ok: true });
    expect(body.nodes.map((n) => n.type)).toEqual([SECTION_DOC_NODE.TEXT]);
    expect(sectionBodyHtml(body)).toBe("<p></p>");
    expect(isLegacyMediaBody(body)).toBe(false);
    expect(resolveSectionQuickAddRoute(body)).toBe(SECTION_QUICK_ADD_ROUTE.DOCUMENT);
    // Whitespace-only answers are the same case, by the existing emptiness rule.
    for (const answer of ["", "   ", "\n\n"]) {
      const b = bodyOf(instanceWith({ answers: { [ROW]: answer } }));
      expect(b.nodes.every((n) => n.type === SECTION_DOC_NODE.TEXT)).toBe(true);
      expect(b.nodes.length).toBeGreaterThan(0);
    }
    // A row with NO body at all (a structured row nobody captured into) is not
    // a document, and Quick Add opens an empty one for it.
    const none = resolveSectionBody({ instance: instanceWith({}), rowId: ROW, rowType: "number" });
    expect(none.source).toBe(SECTION_BODY_SOURCE.EMPTY);
    expect(sectionEditorEligibility(none)).toEqual({
      ok: false,
      reason: SECTION_EDITOR_REFUSAL.NO_BODY,
    });
    expect(resolveSectionQuickAddRoute(none)).toBe(SECTION_QUICK_ADD_ROUTE.DOCUMENT);
  });

  test("B. an empty legacy answer + evidence BEGINS with the evidence — no manufactured paragraph", () => {
    for (const answer of [undefined, "", "   ", { format: "richtext/1", html: "<p></p>" }]) {
      const instance = instanceWith({
        answers: answer === undefined ? {} : { [ROW]: answer },
        evidence: { [ROW]: [photoEvidence(), fileEvidence()] },
      });
      const body = bodyOf(instance);
      expect(body.source).toBe(SECTION_BODY_SOURCE.LEGACY);
      expect(isLegacyMediaBody(body)).toBe(true);
      expect(sectionEditorEligibility(body)).toEqual({ ok: true });
      // The document begins with the media, in stored order, each exactly once.
      expect(body.nodes.map((n) => n.type)).toEqual([
        SECTION_DOC_NODE.IMAGE,
        SECTION_DOC_NODE.FILE,
      ]);
      const html = sectionBodyHtml(body);
      expect(html.startsWith("<p>")).toBe(false);
      expect(html.split(PHOTO_ASSET).length - 1).toBe(1);
      expect(html.split(FILE_ASSET).length - 1).toBe(1);
      // …and so does its static rendering: no prose segment, therefore no blank
      // line and no prompt above the picture.
      const segments = sectionDocSegments(body);
      expect(segments.map((s) => s.kind)).toEqual([
        SECTION_SEGMENT_KIND.IMAGE,
        SECTION_SEGMENT_KIND.FILE,
      ]);
      // Asset references and the frozen stored sources are untouched.
      expect(body.nodes[0].attrs.assetId).toBe(PHOTO_ASSET);
      expect(body.nodes[1].attrs.assetId).toBe(FILE_ASSET);
      expect(instance.evidence[ROW]).toHaveLength(2);
      expect(instance.answers).toEqual(answer === undefined ? {} : { [ROW]: answer });
    }
  });

  test("B2. the row plans as document segments — its evidence is never ALSO rendered as legacy blocks", () => {
    const instance = instanceWith({ evidence: { [ROW]: [photoEvidence()] } });
    const body = bodyOf(instance);
    const blocks = planRowBlocks({
      row: { id: ROW, label: "Photos", type: "text", px: 200 },
      evidence: instance.evidence,
      sectionSegments: sectionDocSegments(body),
    });
    expect(blocks.map((b) => b.kind)).toEqual([ROW_BLOCK_KIND.SECTION_SEGMENT]);
    expect(blocks.filter((b) => b.kind === ROW_BLOCK_KIND.EVIDENCE)).toHaveLength(0);
    // The head segment IS the media, so the head slot renders the zero-height
    // lead-in above it rather than an empty prose box.
    expect(blocks[0].isRowHead).toBe(true);
    expect(blocks[0].sectionSegment.kind).toBe(SECTION_SEGMENT_KIND.IMAGE);
  });

  test("C. prose + evidence keeps the prose FIRST, unchanged", () => {
    const body = bodyOf(
      instanceWith({
        answers: { [ROW]: "The site was wet." },
        evidence: { [ROW]: [photoEvidence()] },
      })
    );
    expect(body.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
    ]);
    const html = sectionBodyHtml(body);
    expect(html.indexOf("The site was wet.")).toBeLessThan(html.indexOf(PHOTO_ASSET));
    expect(isLegacyMediaBody(body)).toBe(true);
    // A single space is not prose the user wrote *around* their photo, but a
    // sentence is: only the empty case drops its paragraph.
    const spaced = adaptLegacyBodyToNodes({ answer: " ", evidence: [photoEvidence()] });
    expect(spaced.nodes.map((n) => n.type)).toEqual([SECTION_DOC_NODE.IMAGE]);
    const written = adaptLegacyBodyToNodes({ answer: "x", evidence: [photoEvidence()] });
    expect(written.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
    ]);
  });

  test("C2. `sources` stays parallel to `nodes`, so the segment projection still matches", () => {
    const empty = adaptLegacyBodyToNodes({ evidence: [photoEvidence(), fileEvidence()] });
    expect(empty.sources).toHaveLength(empty.nodes.length);
    expect(empty.sources.map((s) => s[0].index)).toEqual([0, 1]);
    expect(empty.sources.map((s) => s[0].id)).toEqual(["e-photo", "e-file"]);
    const prose = adaptLegacyBodyToNodes({ answer: "hello", evidence: [photoEvidence()] });
    expect(prose.sources).toHaveLength(prose.nodes.length);
    // The answer's provenance part is the one that names no stored item.
    expect(prose.sources[0][0]).toEqual({ index: -1, id: null, blocks: 1 });
  });

  test("C3. an EMPTY answer whose evidence cannot be carried KEEPS its paragraph, and the row is refused", () => {
    const body = bodyOf(
      instanceWith({ evidence: { [ROW]: ["data:image/png;base64,AAAA"] } })
    );
    // The paragraph is dropped only when there is evidence to BEGIN the document
    // with. Nothing could be carried here, so the empty answer is still what the
    // body is — and the uncarryable entry is reported, which refuses the row.
    expect(body.nodes.map((n) => n.type)).toEqual([SECTION_DOC_NODE.TEXT]);
    expect(body.skipped).toHaveLength(1);
    expect(sectionEditorEligibility(body)).toEqual({
      ok: false,
      reason: SECTION_EDITOR_REFUSAL.UNREPRESENTABLE,
    });
    expect(resolveSectionQuickAddRoute(body)).toBe(SECTION_QUICK_ADD_ROUTE.REFUSE);
  });

  test("D. a MODERN document beginning with media is unaffected — it is read as stored", () => {
    const body = bodyOf(instanceWith({ sectionDoc: { [ROW]: fileOnlyDoc() } }));
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_DOC);
    expect(body.nodes.map((n) => n.type)).toEqual([SECTION_DOC_NODE.FILE]);
    expect(isLegacyMediaBody(body)).toBe(false); // a media-first body, but not LEGACY

    // A stored document that genuinely begins with an empty paragraph keeps it:
    // the adapter's rule is about ADAPTING an absent answer, never about editing
    // a document somebody wrote.
    const withLead = sectionDocHtmlFromNodes([
      { type: SECTION_DOC_NODE.TEXT, blocks: [{ type: "paragraph", align: "left", content: [] }] },
      {
        type: SECTION_DOC_NODE.FILE,
        attrs: { assetId: FILE_ASSET, name: "report.pdf", mimeType: "application/pdf", size: 4096 },
      },
    ]);
    const stored = bodyOf(
      instanceWith({ sectionDoc: { [ROW]: { format: SECTION_DOC_FORMAT, html: withLead } } })
    );
    expect(stored.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.FILE,
    ]);
    expect(sectionBodyHtml(stored)).toBe(withLead);
  });

  test("D2. an adapted `sectionContent` body is unaffected — only the LEGACY answer path changed", () => {
    const body = bodyOf(
      instanceWith({
        sectionContent: { [ROW]: [textItem("t1", ""), photoEvidence({ id: "p1" })] },
      })
    );
    // An EMPTY stored TextItem is real authored content and keeps its paragraph.
    expect(body.source).toBe(SECTION_BODY_SOURCE.SECTION_CONTENT);
    expect(body.nodes.map((n) => n.type)).toEqual([
      SECTION_DOC_NODE.TEXT,
      SECTION_DOC_NODE.IMAGE,
    ]);
  });
});
