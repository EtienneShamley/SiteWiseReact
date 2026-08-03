// Markdown export: an honest structured document, not a claim of branding.

import { buildTemplateExportMarkdown } from "./templateExportMarkdown";
import { EXPORT_UNIT } from "./templateExportModel";
import { normalizeBranding } from "./templateBranding";

const text = (value, marks = {}) => ({ type: "text", text: value, marks });
const para = (...content) => ({
  type: EXPORT_UNIT.BLOCK,
  block: { type: "paragraph", align: "left", content },
});

function model(rows = [], overrides = {}) {
  return {
    note: { id: "note-1", title: "Kingsway site visit" },
    template: {
      id: "tpl-1",
      name: "Site Inspection",
      versionId: "ver-1",
      versionCreatedAt: 1700000000000,
    },
    branding: normalizeBranding({
      title: { enabled: true, text: "Site Inspection Report" },
    }),
    layout: { leftPct: 20 },
    logo: null,
    rows,
    placementFallbacks: [],
    evidence: { totalPhotos: 0, totalFiles: 0, unavailablePhotos: 0, unavailableFiles: 0 },
    ...overrides,
  };
}

const row = (id, label, units) => ({ kind: "master", id, label, type: "text", units });

test("the document opens with the note title and template provenance", () => {
  const md = buildTemplateExportMarkdown(model([row("a", "Observations", [para(text("ok"))])]));
  expect(md).toContain("# Kingsway site visit");
  expect(md).toContain("## Site Inspection Report");
  expect(md).toContain("**Template:** Site Inspection");
  expect(md).toContain("**Template version:** published");
});

test("fields appear in document order with their labels and answers", () => {
  const md = buildTemplateExportMarkdown(
    model([
      row("a", "First", [para(text("one"))]),
      row("b", "Second", [para(text("two"))]),
      { kind: "custom", id: "c", label: "Access notes", type: "text", units: [para(text("three"))] },
    ])
  );
  expect(md.indexOf("### First")).toBeLessThan(md.indexOf("### Second"));
  expect(md.indexOf("### Second")).toBeLessThan(md.indexOf("### Access notes"));
  expect(md).toContain("one");
  expect(md).toContain("three");
  // Each row appears exactly once.
  expect(md.match(/### Access notes/g)).toHaveLength(1);
});

test("emphasis, strike and links degrade to Markdown; colour and underline stay readable", () => {
  const md = buildTemplateExportMarkdown(
    model([
      row("a", "Notes", [
        para(
          text("bold", { bold: true }),
          text(" italic", { italic: true }),
          text(" struck", { strike: true }),
          text(" linked", { link: "https://example.com/" }),
          text(" underlined", { underline: true }),
          text(" coloured", { color: "#ff0000" })
        ),
      ]),
    ])
  );
  expect(md).toContain("**bold**");
  expect(md).toContain("_ italic_");
  expect(md).toContain("~~ struck~~");
  expect(md).toContain("[ linked](https://example.com/)");
  // No equivalent exists: the words survive as plain text rather than vanishing.
  expect(md).toContain("underlined");
  expect(md).toContain("coloured");
});

test("lists keep their structure and ordered numbering", () => {
  const md = buildTemplateExportMarkdown(
    model([
      row("a", "Steps", [
        {
          type: EXPORT_UNIT.BLOCK,
          block: {
            type: "orderedList",
            start: 3,
            items: [
              [{ type: "paragraph", align: "left", content: [text("third")] }],
              [{ type: "paragraph", align: "left", content: [text("fourth")] }],
            ],
          },
        },
        {
          type: EXPORT_UNIT.BLOCK,
          block: {
            type: "bulletList",
            items: [[{ type: "paragraph", align: "left", content: [text("point")] }]],
          },
        },
      ]),
    ])
  );
  expect(md).toContain("3. third");
  expect(md).toContain("4. fourth");
  expect(md).toContain("- point");
});

test("literal markup in a legacy answer stays literal", () => {
  const md = buildTemplateExportMarkdown(
    model([row("a", "Notes", [para(text("<b>Failed</b> **not bold**"))])])
  );
  expect(md).toContain("\\*\\*not bold\\*\\*");
  expect(md).toContain("<b>Failed</b>");
});

test("photo evidence is referenced honestly and never embedded", () => {
  const md = buildTemplateExportMarkdown(
    model([
      row("a", "Evidence", [
        {
          type: EXPORT_UNIT.PHOTO,
          name: "roof.jpg",
          dataUrl: "data:image/jpeg;base64,AAA",
          unavailable: false,
        },
        {
          type: EXPORT_UNIT.PHOTO,
          name: "gone.jpg",
          dataUrl: null,
          unavailable: true,
          unavailableText: "Photo unavailable.",
        },
      ]),
    ])
  );
  expect(md).toContain("Photo evidence: roof.jpg");
  expect(md).toContain("image not included in this Markdown export");
  expect(md).toContain("Photo unavailable.");
  expect(md).not.toContain("data:image");
});

test("file evidence carries metadata and the not-included wording", () => {
  const md = buildTemplateExportMarkdown(
    model([
      row("a", "Documents", [
        {
          type: EXPORT_UNIT.FILE,
          name: "survey.pdf",
          meta: "PDF · 1.3 MB",
          note: "Attached file, not included in this export.",
          unavailable: false,
        },
      ]),
    ])
  );
  expect(md).toContain("survey.pdf");
  expect(md).toContain("PDF · 1.3 MB");
  expect(md).toContain("Attached file, not included in this export.");
});

test("a blank answer writes nothing rather than undefined or null", () => {
  const md = buildTemplateExportMarkdown(
    model([row("a", "Empty field", [{ type: EXPORT_UNIT.EMPTY }])])
  );
  expect(md).toContain("### Empty field");
  expect(md).not.toContain("undefined");
  expect(md).not.toContain("null");
});

test("no internal identifier reaches the output", () => {
  const md = buildTemplateExportMarkdown(
    model([row("f-text", "Notes", [para(text("ok"))])])
  );
  for (const id of ["note-1", "tpl-1", "ver-1", "f-text"]) {
    expect(md).not.toContain(id);
  }
});

test("a placement fallback is reported", () => {
  const md = buildTemplateExportMarkdown(
    model([], { placementFallbacks: [{ label: "Access notes" }] })
  );
  expect(md).toContain("> The section");
  expect(md).toContain("Access notes");
});

test("an absent version date simply omits the version line", () => {
  const md = buildTemplateExportMarkdown(
    model([], {
      template: { id: "t", name: "T", versionId: "v", versionCreatedAt: null },
    })
  );
  expect(md).not.toContain("**Template version:**");
  expect(md).toContain("**Template:** T");
});
