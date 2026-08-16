// Heavy libs will load only when needed (keeps bundle lean)
import { resolveExportImageHtml } from "./exportImageAssets";
import { resolveExportFileAttachmentHtml } from "./exportFileAttachments";
import { mediaWrapExportCss } from "./editorMediaLayout";

let TurndownServiceMod = null;
let gfmPluginFn = null;

/**
 * The ONE place stored note HTML is turned into exportable HTML.
 *
 * Two resolutions, in order, both on a detached copy — the editor document, the
 * stored note HTML and the stored assets are never touched:
 *
 *   1. Images are references to IndexedDB Blobs, and an exported file has to
 *      stand alone, so they are inlined as data URLs. This step THROWS with a
 *      user-facing message when an image cannot be produced, which aborts the
 *      export rather than downloading a document with a photo silently missing.
 *   2. File attachments cannot be embedded in any of these formats, so each
 *      becomes a static reference that says so. A missing attachment does not
 *      abort the export — it is reported in place. This step also neutralizes
 *      any legacy `blob:` anchor, so no dead temporary URL can reach a file.
 *
 * Both are idempotent, so calling this on already-resolved HTML is a scan
 * rather than a second read.
 */
export const resolveExportHtml = async (html) =>
  resolveExportFileAttachmentHtml(await resolveExportImageHtml(html));

export const suggestedTitle = (editor) => {
  if (!editor) return "notewise-note";
  const html = editor.getHTML();
  const h = html.match(/<h[12][^>]*>(.*?)<\/h[12]>/i);
  if (h) {
    const tmp = document.createElement("div");
    tmp.innerHTML = h[1];
    return (tmp.textContent || "notewise-note").trim();
  }
  const t = editor.getText().trim().replace(/\s+/g, " ");
  return t ? t.slice(0, 40) : "notewise-note";
};

export const safeFilename = (base, ext) => {
  const clean = (base || "notewise-note")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .trim()
    .slice(0, 80);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${clean || "notewise-note"}_${ts}.${ext}`;
};

// A short-lived object URL that exists only for the click, then is gone — the
// same shape templateExport.js's own downloadBlob helper uses. Kept local
// rather than imported, so this module has no dependency on that one.
function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * `wrapMedia` decides whether the document renders wrapped image placement
 * (the shared media core's `data-layout-*` attributes) as real CSS floats.
 * The standalone HTML export says yes — the exported page then reflows text
 * beside the image exactly as the editor did. The DOCX path says NO, on
 * purpose: html-to-docx cannot represent CSS float wrap reliably, so its
 * input carries no float rules at all and every image degrades to block
 * placement deterministically — and the DOCX layout preview, which renders
 * this same string, shows that honestly instead of a wrap the .docx file
 * does not contain. `.tiptap-content` is `flow-root` so a float near the end
 * of the note extends the document rather than escaping it.
 */
export const buildHTMLDoc = (html, { wrapMedia = true } = {}) => `
  <html><head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { --fg:#111; --muted:#555; --border:#ccc; }
      @page { size: A4; margin: 12mm; }
      * { box-sizing: border-box; }
      body { font-family: Arial, sans-serif; color: var(--fg); background:#fff; }
      .tiptap-content { max-width:820px; margin:0 auto; line-height:1.5; font-size:12pt; display:flow-root; }
      img { max-width:100%; height:auto; display:inline-block; }
      ${wrapMedia ? mediaWrapExportCss(".tiptap-content") : ""}
      table { border-collapse: collapse; width:100%; margin:10px 0; }
      td, th { border:1px solid var(--border); padding:6px; vertical-align:top; }
      blockquote { border-left:3px solid var(--muted); padding-left:10px; color:var(--muted); margin:8px 0; }
      code, pre { font-family: ui-monospace, Menlo, Monaco, Consolas, "Courier New", monospace; font-size:0.95em; }
      pre { background:#f5f5f5; padding:8px; overflow:auto; }
      h1, h2, h3 { page-break-after: avoid; }
      .page-break { page-break-before: always; }
      /* An attached file cannot be embedded in this format. It is rendered as
         a plain, honest reference — never as something that looks clickable. */
      .note-file-attachment-export {
        border:1px solid var(--border); border-radius:4px;
        padding:6px 8px; margin:8px 0; font-size:0.95em;
        page-break-inside: avoid;
      }
      .note-file-attachment-export span { color: var(--muted); }
    </style>
  </head>
  <body><div class="tiptap-content">${html}</div></body></html>
`;

async function turndownService() {
  if (!TurndownServiceMod) {
    const mod = await import("turndown");
    TurndownServiceMod = mod.default || mod;
  }
  if (!gfmPluginFn) {
    const mod = await import("turndown-plugin-gfm");
    gfmPluginFn = mod.gfm || (mod.default && mod.default.gfm) || mod.default;
  }
  const td = new TurndownServiceMod({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  if (gfmPluginFn) td.use(gfmPluginFn);
  return td;
}

/* ========================================================================
 * ONE producer per format, returning a Blob WITHOUT downloading it.
 *
 * Every caller — the direct export control (below), the ShareDialog single-
 * file and ZIP paths, and the Document Preview dialog — builds its file
 * through exactly these four functions (this one plus the PDF sibling in
 * freeformExportPdf.js). There is no second copy of the HTML/DOCX/Markdown
 * building logic anywhere in the application.
 *
 * All three take the same `{ title, html }` shape the `*String` exporters
 * below already used — raw, UNRESOLVED note HTML; each resolves image and
 * file-attachment references itself, exactly like the PDF pipeline's own
 * snapshot.html contract.
 * ==================================================================== */

export async function buildFreeformHtmlFile({ title, html }) {
  const resolved = await resolveExportHtml(html);
  const text = buildHTMLDoc(resolved);
  return {
    name: safeFilename(title, "html"),
    // The exact string is carried alongside the Blob so a caller that only
    // needs to DISPLAY the document (Document Preview renders it through an
    // iframe `srcDoc`) never has to read it back out of the Blob — and, more
    // importantly, never has to point a SANDBOXED iframe at a `blob:` URL,
    // which a browser refuses to load into an opaque origin.
    text,
    blob: new Blob([text], { type: "text/html;charset=utf-8" }),
  };
}

export async function buildFreeformMarkdownFile({ title, html }) {
  const resolved = await resolveExportHtml(html);
  const td = await turndownService();
  const text = td.turndown(resolved);
  return {
    name: safeFilename(title, "md"),
    // The exact string is carried alongside the Blob so a caller that only
    // needs to DISPLAY the Markdown (Document Preview's Source view) never
    // has to re-read it back out of the Blob.
    text,
    blob: new Blob([text], { type: "text/markdown;charset=utf-8" }),
  };
}

export async function buildFreeformDocxFile({ title, html }) {
  const resolved = await resolveExportHtml(html);
  // Use the ESM build shipped by the installed package version.
  const mod = await import("html-to-docx/dist/html-to-docx.esm.js");
  const htmlToDocx = mod.default || mod;
  // The EXACT html-to-docx input, returned as a field of its OWN — never as
  // the file's content, and never interchangeable with `blob`. Document
  // Preview's "Approximate DOCX layout preview" renders this string rather
  // than independently recreating one: a browser cannot render .docx natively,
  // but this is the real, unmodified input the real DOCX was converted from.
  // wrapMedia: false — wrapped image placement degrades to block in DOCX (see
  // buildHTMLDoc), and the preview shows exactly that degradation.
  const previewHtml = buildHTMLDoc(resolved, { wrapMedia: false });
  const converted = await htmlToDocx(previewHtml, null, {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
  });
  return {
    name: safeFilename(title, "docx"),
    previewHtml,
    blob: new Blob([converted], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  };
}

/**
 * The Free-form PDF.
 *
 * Unlike the other three formats this takes a captured SNAPSHOT, not a live
 * editor: the PDF is paginated against measured content, which is asynchronous
 * work, and a live editor must not be read across it. The snapshot is built
 * synchronously by the caller (see freeformExportPdf.captureFreeformExportSnapshot).
 *
 * The runner is loaded lazily, exactly like html2pdf itself — it also keeps
 * this module free of a static cycle, since the runner needs `safeFilename`
 * from here.
 */
export async function exportPDF(snapshot) {
  const { exportFreeformPdf } = await import("./freeformExportPdf");
  return exportFreeformPdf(snapshot);
}

export async function exportDOCX(editor) {
  const file = await buildFreeformDocxFile({
    title: suggestedTitle(editor),
    html: editor.getHTML(),
  });
  downloadBlob(file.blob, file.name);
}

export async function exportHTML(editor) {
  const file = await buildFreeformHtmlFile({
    title: suggestedTitle(editor),
    html: editor.getHTML(),
  });
  downloadBlob(file.blob, file.name);
}

export async function exportMD(editor) {
  const file = await buildFreeformMarkdownFile({
    title: suggestedTitle(editor),
    html: editor.getHTML(),
  });
  downloadBlob(file.blob, file.name);
}

// The `*String` variants take note HTML read straight from storage (see
// ShareDialog), so they resolve image and attachment references through the
// same helper the editor-based exporters use. Each is now a thin download
// wrapper around the same build function the editor-based exporter above uses.
export const exportHTMLString = async ({ title, html }) => {
  const file = await buildFreeformHtmlFile({ title, html });
  downloadBlob(file.blob, file.name);
};

// Stored note HTML goes through the SAME paginated runner the export control
// uses, so the ShareDialog cannot produce a differently laid-out Free-form PDF.
// It resolves its own images and attachments, which is why the raw stored HTML
// is handed over rather than a pre-resolved string.
export const exportPDFString = async ({ title, html }) => {
  const { captureFreeformExportSnapshot, exportFreeformPdf } = await import(
    "./freeformExportPdf"
  );
  return exportFreeformPdf(
    captureFreeformExportSnapshot({ noteTitle: title, html })
  );
};

export const exportDOCXString = async ({ title, html }) => {
  const file = await buildFreeformDocxFile({ title, html });
  downloadBlob(file.blob, file.name);
};

export const exportMDString = async ({ title, html }) => {
  const file = await buildFreeformMarkdownFile({ title, html });
  downloadBlob(file.blob, file.name);
};
