// src/components/mobile/MobilePdfScreen.js
//
// THE PHONE PDFS SCREEN (Phase 8E.1) — the PDF library as a touch list, and
// the phone PDF VIEWER for the open document.
//
// Phone V1 is a viewer, not an editor: the desktop PDF editor and its
// annotation workspace are never mounted here. The open document is the
// application state's `currentPdfId` — the same value the desktop PDFs
// workspace reads — so a PDF opened on one shell is the PDF open on the other.
// Uploading a PDF is the application state's existing `createGlobalPdf`,
// unchanged (content-validated there).
import React, { useRef } from "react";
import { FaChevronLeft, FaFilePdf, FaPlus } from "react-icons/fa";
import { useAppState } from "../../context/AppStateContext";
import { actionButtonClass } from "../../lib/interactionStyles";
import MobileListRow from "./MobileListRow";
import MobilePdfViewer from "./MobilePdfViewer";
import { MobileHeaderBar } from "./MobileDrawerTrigger";

function updatedLine(doc) {
  const when = doc && (doc.updatedAt || doc.createdAt);
  if (!when) return "PDF";
  try {
    return `Updated ${new Date(when).toLocaleDateString()}`;
  } catch {
    return "PDF";
  }
}

export default function MobilePdfScreen() {
  const app = useAppState() || {};
  const { listAllPdfs, createGlobalPdf, setCurrentPdfId, currentPdfId = null, getPdfDocById } = app;
  const inputRef = useRef(null);
  const doc = currentPdfId && typeof getPdfDocById === "function" ? getPdfDocById(currentPdfId) : null;

  if (doc) {
    return (
      <div className="nw-phone-pdf" data-nw-phone-pdf="viewer">
        <header className="nw-phone-screen-header">
          <MobileHeaderBar>
            <button
              type="button"
              className="nw-phone-back"
              onClick={() => setCurrentPdfId(null)}
              aria-label="Back to PDFs"
            >
              <FaChevronLeft aria-hidden="true" />
              <span>PDFs</span>
            </button>
          </MobileHeaderBar>
          <h1 className="nw-phone-title">{doc.name}</h1>
          <p className="nw-phone-subtitle">Viewing · annotation is available on a larger screen</p>
        </header>
        <MobilePdfViewer key={doc.id} doc={doc} />
      </div>
    );
  }

  const pdfs = typeof listAllPdfs === "function" ? listAllPdfs() : [];
  const onUpload = async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file || typeof createGlobalPdf !== "function") return;
    const created = await createGlobalPdf(file);
    if (created) setCurrentPdfId(created.id);
  };

  return (
    <div className="nw-phone-screen-inner" data-nw-phone-pdf="library">
      <header className="nw-phone-screen-header">
        <MobileHeaderBar />
        <h1 className="nw-phone-title">PDFs</h1>
        <p className="nw-phone-subtitle">Standalone documents</p>
      </header>
      <section className="nw-phone-section" aria-label="PDFs">
        {pdfs.length === 0 ? (
          <p className="nw-phone-empty">No PDFs yet.</p>
        ) : (
          <ul className="nw-phone-list">
            {pdfs.map((pdf) => (
              <MobileListRow
                key={pdf.id}
                kind="pdf"
                id={pdf.id}
                icon={FaFilePdf}
                name={pdf.name}
                meta={updatedLine(pdf)}
                onClick={() => setCurrentPdfId(pdf.id)}
              />
            ))}
          </ul>
        )}
      </section>
      <div className="nw-phone-actions">
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          onChange={onUpload}
          className="hidden"
          aria-label="Upload a PDF"
        />
        <button
          type="button"
          className={actionButtonClass({ className: "nw-phone-action" })}
          onClick={() => inputRef.current && inputRef.current.click()}
        >
          <FaPlus aria-hidden="true" />
          <span>Upload PDF</span>
        </button>
      </div>
    </div>
  );
}
