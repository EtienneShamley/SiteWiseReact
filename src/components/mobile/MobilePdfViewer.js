// src/components/mobile/MobilePdfViewer.js
//
// THE PHONE PDF VIEWER (Phase 8E.1): open, read, move between pages, zoom and
// find — and nothing that changes the document.
//
// It reads through the same boundaries the desktop editor reads through
// (src/lib/pdfViewerSource.js): the asset read boundary for the source bytes
// and the workspace's annotation record. Annotations are drawn by the SAME
// flattening the desktop export uses, so the phone shows what an export of
// the document contains. There is no annotator, no annotation writer, no
// "Open PDF" replacement, no byte-cache write and no object URL here.
//
// It also views ONE TRANSIENT FILE handed to it (`file`): the exact PDF the
// phone Document Preview generated (DocumentPreviewDialog.js). That file is
// already the finished export, so it is opened as it is — no asset read, no
// annotation record, no flattening, no cache — and only read, never changed:
// Download keeps sending the very same Blob.
//
// Pages render lazily as they approach the viewport, at a device-pixel ratio
// capped for phone memory, and every page keeps its real proportions before
// it renders so the scroll position never jumps.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FaArrowsAltH,
  FaChevronDown,
  FaChevronUp,
  FaSearch,
  FaSearchMinus,
  FaSearchPlus,
  FaTimes,
} from "react-icons/fa";
import { flattenAnnotations, getDocumentLayout, loadPdf, renderPageToCanvas } from "../../lib/pdfUtils";
import { loadAnnotations } from "../../lib/pdfStorage";
import { activeAssetWorkspaceId } from "../../lib/assetStorage";
import { ASSET_READ_STATE, readAssetWithState } from "../../lib/assetReader";
import {
  ASSET_READ_SURFACE,
  RETRY_ASSET_READ_LABEL,
  assetReadMessage,
  isRetryableAssetRead,
} from "../../lib/assetReadPresentation";
import { ASSET_KIND_PDF_SOURCE } from "../../lib/localAssetCache";
import { pdfSourceId } from "../../lib/pdfDocuments";
import { extractPageIndex, findMatchesInDocument } from "../../lib/pdfSearch";
import { normalizeAnnotationList } from "../../lib/pdfAnnotationModel";
import { useAppState } from "../../context/AppStateContext";
import {
  PDF_VIEWER_NOTICE,
  PDF_VIEWER_ZOOM_STEPS,
  annotationsByPage,
  currentPageFromScroll,
  fitWidthScale,
  loadPdfForViewing,
  nextViewerZoom,
  pageMetasFromLayout,
} from "../../lib/pdfViewerSource";

const MAX_PIXEL_RATIO = 2;

function blobToBytes(blob) {
  if (blob instanceof Uint8Array) return Promise.resolve(blob);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error || new Error("The PDF could not be read."));
    reader.readAsArrayBuffer(blob);
  });
}

function destroyDocument(pdfDoc) {
  try {
    if (pdfDoc && typeof pdfDoc.destroy === "function") pdfDoc.destroy();
  } catch {
    // already released
  }
}

function ViewerPage({ pdfDoc, meta, scale, registerPage }) {
  const hostRef = useRef(null);
  const [near, setNear] = useState(
    () => typeof window === "undefined" || typeof window.IntersectionObserver !== "function"
  );

  useEffect(() => {
    const el = hostRef.current;
    if (!el || near || typeof window.IntersectionObserver !== "function") return undefined;
    const observer = new window.IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || !pdfDoc || !(scale > 0)) return undefined;
    let cancelled = false;
    const ratio = Math.min(
      MAX_PIXEL_RATIO,
      (typeof window !== "undefined" && window.devicePixelRatio) || 1
    );
    (async () => {
      try {
        const { canvas } = await renderPageToCanvas(pdfDoc, meta.pageNo, scale * ratio);
        const host = hostRef.current;
        if (cancelled || !host) return;
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.display = "block";
        while (host.firstChild) host.removeChild(host.firstChild);
        host.appendChild(canvas);
      } catch {
        // The page stays a blank sheet of the right size; the rest of the
        // document remains readable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [near, pdfDoc, meta.pageNo, scale]);

  return (
    <div
      ref={(el) => {
        hostRef.current = el;
        registerPage(meta.pageNo, el);
      }}
      className="nw-phone-pdf-page"
      style={{ width: Math.round(meta.baseW * scale), height: Math.round(meta.baseH * scale) }}
      role="img"
      aria-label={`Page ${meta.pageNo}`}
      data-nw-pdf-view-page={meta.pageNo}
    />
  );
}

/**
 * @param doc   a stored PDF document (the PDFs screen): read through the asset
 *              boundary, annotations flattened as the export does.
 * @param file  OR a finished PDF to show exactly as it is — a Blob or the
 *              bytes. Used instead of `doc` when given.
 */
export default function MobilePdfViewer({ doc = null, file = null }) {
  const app = useAppState() || {};
  const cacheRef = useRef(app.getPdfBytesCache);
  cacheRef.current = app.getPdfBytesCache;
  const docId = doc ? doc.id : null;
  const sourceId = doc ? pdfSourceId(doc) : null;

  const [read, setRead] = useState({ status: ASSET_READ_STATE.LOADING, code: null, openFailed: false });
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState({ pdfDoc: null, layout: [] });
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    let opened = null;
    setRead({ status: ASSET_READ_STATE.LOADING, code: null, openFailed: false });
    setView({ pdfDoc: null, layout: [] });
    setNotice("");
    (async () => {
      let result;
      if (file) {
        try {
          result = { status: ASSET_READ_STATE.READY, code: null, bytes: await blobToBytes(file), annotations: [] };
        } catch {
          if (!cancelled) setRead({ status: ASSET_READ_STATE.ERROR, code: null, openFailed: true });
          return;
        }
      } else {
        const cached = typeof cacheRef.current === "function" ? cacheRef.current(sourceId) : null;
        result = await loadPdfForViewing({
          docId,
          sourceId,
          workspaceId: activeAssetWorkspaceId(),
          readAsset: readAssetWithState,
          readAnnotations: loadAnnotations,
          sourceKind: ASSET_KIND_PDF_SOURCE,
          cachedBytes: cached,
          onPhase: (phase) => {
            if (!cancelled) setRead({ status: phase, code: null, openFailed: false });
          },
        });
      }
      if (cancelled) return;
      if (result.status !== ASSET_READ_STATE.READY || !result.bytes) {
        setRead({ status: result.status, code: result.code, openFailed: false });
        return;
      }
      try {
        let pdfDoc = await loadPdf(result.bytes.slice(0));
        let layout = await getDocumentLayout(pdfDoc);
        const items = normalizeAnnotationList(result.annotations);
        if (items.length > 0) {
          try {
            const blob = await flattenAnnotations(
              result.bytes.slice(0),
              annotationsByPage(items),
              pageMetasFromLayout(layout)
            );
            const flattened = await blobToBytes(blob);
            const flatDoc = await loadPdf(flattened);
            const flatLayout = await getDocumentLayout(flatDoc);
            destroyDocument(pdfDoc);
            pdfDoc = flatDoc;
            layout = flatLayout;
          } catch {
            if (!cancelled) setNotice(PDF_VIEWER_NOTICE.ANNOTATIONS_UNAVAILABLE);
          }
        }
        if (cancelled) {
          destroyDocument(pdfDoc);
          return;
        }
        opened = pdfDoc;
        setView({ pdfDoc, layout });
        setRead({ status: ASSET_READ_STATE.READY, code: null, openFailed: false });
      } catch {
        if (!cancelled) setRead({ status: ASSET_READ_STATE.ERROR, code: null, openFailed: true });
      }
    })();
    return () => {
      cancelled = true;
      destroyDocument(opened);
    };
  }, [docId, sourceId, file, attempt]);

  /* ------------------------------ geometry -------------------------------- */

  const scrollRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measure = () => setContainerWidth(el.clientWidth || 0);
    measure();
    if (typeof window.ResizeObserver === "function") {
      const observer = new window.ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const [zoom, setZoom] = useState(PDF_VIEWER_ZOOM_STEPS[0]);
  const firstPage = view.layout[0];
  const scale = fitWidthScale({ containerWidth, pageWidth: firstPage ? firstPage.baseW : 0 }) * zoom;
  const total = view.layout.length;

  const pageEls = useRef({});
  const registerPage = useCallback((pageNo, el) => {
    if (el) pageEls.current[pageNo] = el;
    else delete pageEls.current[pageNo];
  }, []);
  const [page, setPage] = useState(1);
  const pageRef = useRef(1);
  pageRef.current = page;

  const goToPage = useCallback(
    (target) => {
      if (!total) return;
      const next = Math.min(Math.max(1, target), total);
      const el = pageEls.current[next];
      const scroller = scrollRef.current;
      if (el && scroller) scroller.scrollTop = Math.max(0, el.offsetTop - 8);
      setPage(next);
    },
    [total]
  );

  // A zoom change keeps the reader on the page they were reading.
  useEffect(() => {
    goToPage(pageRef.current);
  }, [zoom, goToPage]);

  const onScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller || !total) return;
    const tops = view.layout.map((meta) => {
      const el = pageEls.current[meta.pageNo];
      return el ? el.offsetTop : Number.POSITIVE_INFINITY;
    });
    const next = currentPageFromScroll({
      scrollTop: scroller.scrollTop,
      viewportHeight: scroller.clientHeight,
      tops,
    });
    if (next && next !== pageRef.current) setPage(next);
  };

  /* -------------------------------- find ---------------------------------- */

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [find, setFind] = useState({ status: "idle", matches: [], index: 0 });
  const indexesRef = useRef(null);
  useEffect(() => {
    indexesRef.current = null;
    setFind({ status: "idle", matches: [], index: 0 });
  }, [view.pdfDoc]);

  const runFind = async (event) => {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    const text = query.trim();
    const pdfDoc = view.pdfDoc;
    if (!text || !pdfDoc) {
      setFind({ status: "idle", matches: [], index: 0 });
      return;
    }
    setFind({ status: "searching", matches: [], index: 0 });
    try {
      if (!indexesRef.current) {
        const indexes = {};
        for (const meta of view.layout) {
          const pdfPage = await pdfDoc.getPage(meta.pageNo);
          indexes[meta.pageNo] = await extractPageIndex(pdfPage);
        }
        indexesRef.current = indexes;
      }
      const matches = findMatchesInDocument(indexesRef.current, text);
      setFind({ status: "done", matches, index: 0 });
      if (matches.length) goToPage(matches[0].page);
    } catch {
      setFind({ status: "failed", matches: [], index: 0 });
    }
  };

  const stepFind = (direction) => {
    const count = find.matches.length;
    if (!count) return;
    const index = (find.index + direction + count) % count;
    setFind({ ...find, index });
    goToPage(find.matches[index].page);
  };

  const findStatus =
    find.status === "searching"
      ? "Searching…"
      : find.status === "failed"
      ? "Search is not available for this PDF."
      : find.status === "done"
      ? find.matches.length
        ? `${find.index + 1} of ${find.matches.length} — page ${find.matches[find.index].page}`
        : "No matches"
      : "";

  /* ------------------------------- render --------------------------------- */

  const busy = read.status === ASSET_READ_STATE.LOADING || read.status === ASSET_READ_STATE.IDLE;
  const unavailable = !busy && read.status !== ASSET_READ_STATE.READY;
  const unavailableMessage = read.openFailed
    ? PDF_VIEWER_NOTICE.OPEN_FAILED
    : unavailable
    ? assetReadMessage({ state: read.status, code: read.code, surface: ASSET_READ_SURFACE.PDF })
    : "";

  return (
    <div className="nw-phone-pdf-viewer" data-nw-pdf-viewer="phone">
      <div className="nw-phone-pdf-toolbar" role="toolbar" aria-label="PDF viewer">
        <button
          type="button"
          className="nw-phone-pdf-btn"
          onClick={() => goToPage(page - 1)}
          disabled={!total || page <= 1}
          aria-label="Previous page"
        >
          <FaChevronUp aria-hidden="true" />
        </button>
        <span className="nw-phone-pdf-pageno" aria-live="polite">
          {total ? `Page ${page} of ${total}` : "—"}
        </span>
        <button
          type="button"
          className="nw-phone-pdf-btn"
          onClick={() => goToPage(page + 1)}
          disabled={!total || page >= total}
          aria-label="Next page"
        >
          <FaChevronDown aria-hidden="true" />
        </button>
        <span className="nw-phone-pdf-spacer" />
        <button
          type="button"
          className="nw-phone-pdf-btn"
          onClick={() => setZoom((z) => nextViewerZoom(z, -1))}
          disabled={!total || zoom <= PDF_VIEWER_ZOOM_STEPS[0]}
          aria-label="Zoom out"
        >
          <FaSearchMinus aria-hidden="true" />
        </button>
        <button
          type="button"
          className="nw-phone-pdf-btn"
          onClick={() => setZoom(PDF_VIEWER_ZOOM_STEPS[0])}
          disabled={!total}
          aria-pressed={zoom === PDF_VIEWER_ZOOM_STEPS[0]}
          aria-label="Fit page width"
        >
          <FaArrowsAltH aria-hidden="true" />
        </button>
        <button
          type="button"
          className="nw-phone-pdf-btn"
          onClick={() => setZoom((z) => nextViewerZoom(z, 1))}
          disabled={!total || zoom >= PDF_VIEWER_ZOOM_STEPS[PDF_VIEWER_ZOOM_STEPS.length - 1]}
          aria-label="Zoom in"
        >
          <FaSearchPlus aria-hidden="true" />
        </button>
        <button
          type="button"
          className="nw-phone-pdf-btn"
          onClick={() => setFindOpen((open) => !open)}
          disabled={!total}
          aria-expanded={findOpen}
          aria-label="Find in PDF"
        >
          <FaSearch aria-hidden="true" />
        </button>
      </div>

      {findOpen && (
        <form className="nw-phone-pdf-find" role="search" onSubmit={runFind}>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find in PDF"
            aria-label="Text to find in this PDF"
            enterKeyHint="search"
          />
          <button type="submit" className="nw-phone-pdf-btn" aria-label="Search">
            <FaSearch aria-hidden="true" />
          </button>
          <button
            type="button"
            className="nw-phone-pdf-btn"
            onClick={() => stepFind(-1)}
            disabled={!find.matches.length}
            aria-label="Previous match"
          >
            <FaChevronUp aria-hidden="true" />
          </button>
          <button
            type="button"
            className="nw-phone-pdf-btn"
            onClick={() => stepFind(1)}
            disabled={!find.matches.length}
            aria-label="Next match"
          >
            <FaChevronDown aria-hidden="true" />
          </button>
          <button
            type="button"
            className="nw-phone-pdf-btn"
            onClick={() => setFindOpen(false)}
            aria-label="Close find"
          >
            <FaTimes aria-hidden="true" />
          </button>
          <span role="status" className="nw-phone-pdf-find-status">
            {findStatus}
          </span>
        </form>
      )}

      {notice && (
        <p role="status" className="nw-phone-pdf-notice">
          {notice}
        </p>
      )}

      <div
        ref={scrollRef}
        className="nw-phone-pdf-scroller"
        onScroll={onScroll}
        data-nw-pdf-view-scroller
      >
        {busy && (
          <p role="status" className="nw-phone-pdf-state">
            Opening PDF…
          </p>
        )}
        {unavailableMessage && (
          <div role="status" className="nw-phone-pdf-state" data-nw-pdf-view-state={read.status}>
            <p>{unavailableMessage}</p>
            {!read.openFailed && isRetryableAssetRead(read.status) && (
              <button
                type="button"
                className="nw-phone-action nw-action"
                onClick={() => setAttempt((n) => n + 1)}
              >
                {RETRY_ASSET_READ_LABEL}
              </button>
            )}
          </div>
        )}
        {view.pdfDoc && containerWidth > 0 && (
          <div className="nw-phone-pdf-pages">
            {view.layout.map((meta) => (
              <ViewerPage
                key={meta.pageNo}
                pdfDoc={view.pdfDoc}
                meta={meta}
                scale={scale}
                registerPage={registerPage}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
