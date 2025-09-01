// Heavy libs will load only when needed (keeps bundle lean)
let TurndownServiceMod = null;
let gfmPluginFn = null;

const baseDocHTML = (editor) => `
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
    </style>
  </head>
  <body><div class="tiptap-content">${editor.getHTML()}</div></body></html>
`;

export const suggestedTitle = (editor) => {
  if (!editor) return "sitewise-note";
  const html = editor.getHTML();
  const h = html.match(/<h[12][^>]*>(.*?)<\/h[12]>/i);
  if (h) {
    const tmp = document.createElement("div");
    tmp.innerHTML = h[1];
    return (tmp.textContent || "sitewise-note").trim();
  }
  const t = editor.getText().trim().replace(/\s+/g, " ");
  return t ? t.slice(0, 40) : "sitewise-note";
};

export const safeFilename = (base, ext) => {
  const clean = (base || "sitewise-note")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .trim()
    .slice(0, 80);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${clean || "sitewise-note"}_${ts}.${ext}`;
};

export async function exportPDF(editor) {
  const [{ default: html2pdf }] = await Promise.all([import("html2pdf.js")]);
  const container = document.createElement("div");
  container.innerHTML = baseDocHTML(editor);
  const opt = {
    margin: 10,
    filename: safeFilename(suggestedTitle(editor), "pdf"),
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
  };
  return html2pdf().from(container).set(opt).save();
}

export async function exportDOCX(editor) {
  // Use the ESM build shipped by your package version
  const mod = await import("html-to-docx/dist/html-to-docx.esm.js");
  const htmlToDocx = mod.default || mod;

  const html = baseDocHTML(editor);
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

export function exportHTML(editor) {
  const html = baseDocHTML(editor);
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
  if (!TurndownServiceMod) {
    const mod = await import("turndown");
    TurndownServiceMod = mod.default || mod;
  }
  if (!gfmPluginFn) {
    const mod = await import("turndown-plugin-gfm");
    gfmPluginFn = mod.gfm || (mod.default && mod.default.gfm) || mod.default;
  }
  const raw = editor.getHTML();
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
    </style>
  </head>
  <body><div class="tiptap-content">${html}</div></body></html>
`;

export const exportHTMLString = ({ title, html }) => {
  const file = new Blob([buildHTMLDoc(html)], { type: "text/html;charset=utf-8" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(file);
  a.href = url;
  a.download = safeFilename(title, "html");
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const exportPDFString = async ({ title, html }) => {
  const [{ default: html2pdf }] = await Promise.all([import("html2pdf.js")]);
  const container = document.createElement("div");
  container.innerHTML = buildHTMLDoc(html);
  const opt = {
    margin: 10,
    filename: safeFilename(title, "pdf"),
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
  };
  return html2pdf().from(container).set(opt).save();
};

export const exportDOCXString = async ({ title, html }) => {
  // ESM path (matches your installed package)
  const mod = await import("html-to-docx/dist/html-to-docx.esm.js");
  const htmlToDocx = mod.default || mod;
  const doc = buildHTMLDoc(html);
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
  const modTD = await import("turndown");
  const TurndownService = modTD.default || modTD;
  const modGFM = await import("turndown-plugin-gfm");
  const gfm = modGFM.gfm || (modGFM.default && modGFM.default.gfm) || modGFM.default;

  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  if (gfm) td.use(gfm);
  const md = td.turndown(html);

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

