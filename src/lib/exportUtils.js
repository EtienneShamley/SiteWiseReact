// Heavy libs will load only when needed (keeps bundle lean)
import { resolveExportImageHtml } from "./exportImageAssets";
import { resolveExportFileAttachmentHtml } from "./exportFileAttachments";

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

const exportableEditorHTML = (editor) => resolveExportHtml(editor.getHTML());

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
  const resolved = await exportableEditorHTML(editor);
  // Use the ESM build shipped by your package version
  const mod = await import("html-to-docx/dist/html-to-docx.esm.js");
  const htmlToDocx = mod.default || mod;

  const html = buildHTMLDoc(resolved);
  const blob = await htmlToDocx(html, null, {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
  });

  const file = new Blob([blob], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });

  const a = document.createElement("a");
  const url = URL.createObjectURL(file);
  a.href = url;
  a.download = safeFilename(suggestedTitle(editor), "docx");
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function exportHTML(editor) {
  const html = buildHTMLDoc(await exportableEditorHTML(editor));
  const file = new Blob([html], { type: "text/html;charset=utf-8" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(file);
  a.href = url;
  a.download = safeFilename(suggestedTitle(editor), "html");
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function exportMD(editor) {
  const raw = await exportableEditorHTML(editor);
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
  const md = td.turndown(raw);
  const file = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(file);
  a.href = url;
  a.download = safeFilename(suggestedTitle(editor), "md");
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const buildHTMLDoc = (html) => `
  <html><head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { --fg:#111; --muted:#555; --border:#ccc; }
      @page { size: A4; margin: 12mm; }
      * { box-sizing: border-box; }
      body { font-family: Arial, sans-serif; color: var(--fg); background:#fff; }
      .tiptap-content { max-width:820px; margin:0 auto; line-height:1.5; font-size:12pt; }
      img { max-width:100%; height:auto; display:inline-block; }
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

// The `*String` variants take note HTML read straight from storage (see
// ShareDialog), so they resolve image and attachment references through the
// same helper the editor-based exporters use.
export const exportHTMLString = async ({ title, html }) => {
  const resolved = await resolveExportHtml(html);
  const file = new Blob([buildHTMLDoc(resolved)], { type: "text/html;charset=utf-8" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(file);
  a.href = url;
  a.download = safeFilename(title, "html");
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  const resolved = await resolveExportHtml(html);
  // ESM path (matches your installed package)
  const mod = await import("html-to-docx/dist/html-to-docx.esm.js");
  const htmlToDocx = mod.default || mod;
  const doc = buildHTMLDoc(resolved);
  const blob = await htmlToDocx(doc, null, {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true
  });
  const file = new Blob([blob], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const a = document.createElement("a");
  const url = URL.createObjectURL(file);
  a.href = url;
  a.download = safeFilename(title, "docx");
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const exportMDString = async ({ title, html }) => {
  const resolved = await resolveExportHtml(html);
  const modTD = await import("turndown");
  const TurndownService = modTD.default || modTD;
  const modGFM = await import("turndown-plugin-gfm");
  const gfm = modGFM.gfm || (modGFM.default && modGFM.default.gfm) || modGFM.default;

  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  if (gfm) td.use(gfm);
  const md = td.turndown(resolved);

  const file = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(file);
  a.href = url;
  a.download = safeFilename(title, "md");
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

