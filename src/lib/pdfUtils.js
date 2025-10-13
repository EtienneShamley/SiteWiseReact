// src/lib/pdfUtils.js
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

// Point the worker to the copy placed in /public
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

/**
 * Accepts Uint8Array | ArrayBuffer | Blob, returns a PDF.js document
 */
export async function loadPdf(src) {
  let bytes;
  if (src instanceof Uint8Array) {
    bytes = src;
  } else if (src instanceof Blob) {
    const ab = await src.arrayBuffer();
    bytes = new Uint8Array(ab);
  } else {
    // ArrayBuffer or ArrayBuffer-like
    // slice(0) ensures we have a fresh, non-detached copy
    const ab = src?.slice ? src.slice(0) : src;
    bytes = new Uint8Array(ab);
  }
  return pdfjsLib.getDocument({ data: bytes }).promise;
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
 * Flatten annotations onto the PDF using pdf-lib.
 * src: Uint8Array | ArrayBuffer | Blob
 * annotations: { [pageNo]: Array<{ type:'highlight'| 'text', ... }> }
 */
export async function flattenAnnotations(src, annotations) {
  let bytes;
  if (src instanceof Uint8Array) {
    bytes = src;
  } else if (src instanceof Blob) {
    const ab = await src.arrayBuffer();
    bytes = new Uint8Array(ab);
  } else {
    const ab = src?.slice ? src.slice(0) : src;
    bytes = new Uint8Array(ab);
  }

  // Load with a safe copy to avoid detached buffers
  const pdfDoc = await PDFDocument.load(bytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const pageNo = i + 1;
    const page = pages[i];
    const { width, height } = page.getSize();

    const anns = annotations?.[pageNo] || [];
    for (const ann of anns) {
      if (ann.type === "highlight") {
        const x = ann.x;
        const y = height - (ann.y + ann.h); // convert top-left to PDF coords
        page.drawRectangle({
          x, y, width: ann.w, height: ann.h,
          color: rgb(1, 1, 0),
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
