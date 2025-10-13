// src/lib/pdfUtils.js
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

// Worker served from /public
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

export async function loadPdf(arrayBuffer) {
  return pdfjsLib.getDocument({ data: arrayBuffer }).promise;
}

export async function renderPageToCanvas(pdfDoc, pageNumber, scale = 1.25) {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, width: canvas.width, height: canvas.height, scale };
}

/**
 * annotations: { [pageNumber]: Array<Ann> }
 * Ann highlight => { type:'highlight', x,y,w,h }
 * Ann text      => { type:'text', x,y,text,fontSize }
 * Coordinates are in PDF pixels at renderScale=1 (we normalize in the editor).
 */
export async function flattenAnnotations(originalArrayBuffer, annotations) {
  const pdfDoc = await PDFDocument.load(originalArrayBuffer);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const pageNo = i + 1;
    const page = pages[i];
    const { width, height } = page.getSize();

    const anns = annotations?.[pageNo] || [];
    for (const ann of anns) {
      if (ann.type === "highlight") {
        // PDF origin is bottom-left; incoming coords are top-left
        const x = ann.x;
        const y = height - (ann.y + ann.h);
        page.drawRectangle({
          x, y, width: ann.w, height: ann.h,
          color: rgb(1, 1, 0), // yellow
          opacity: 0.25,
          borderOpacity: 0,
        });
      } else if (ann.type === "text") {
        const text = String(ann.text || "");
        if (!text) continue;
        const fs = Math.max(8, Math.min(48, Number(ann.fontSize || 14)));
        const x = ann.x;
        const y = height - ann.y - fs; // baseline adjust
        page.drawText(text, { x, y, size: fs, font, color: rgb(0, 0, 0) });
      }
    }
  }

  const out = await pdfDoc.save();
  return new Blob([out], { type: "application/pdf" });
}
