// src/components/editor/PhotoAnnotatorDialog.js
//
// THE PHOTO ANNOTATOR WORKSPACE (P4): a focused, modal workspace over the
// document in which one stored photograph is marked up with the SAME
// annotation engine the PDF editor uses — the same overlay
// (src/pdf/PdfAnnotator.js), tools, contextual options row, selection,
// history and clipboard — over a one-page raster surface in native image
// pixels (src/lib/photoAnnotation.js).
//
// What this component owns, and nothing else:
//   - loading the photo to annotate (the ORIGINAL when the image is already an
//     annotated rendition, so no save is ever derived from a previous save);
//   - the ribbon (the image tool catalogue, undo/redo/select-all/delete,
//     zoom) and the shared options row, over the shared overlay;
//   - zoom/fit/pan — presentation only, exactly as in the PDF tab;
//   - dirty state, from the overlay's COMMITTED changes alone (selection,
//     zoom, marquee and a callout draft never dirty it);
//   - Save → rasterize (src/lib/imageAnnotationRaster.js) and hand the result
//     to `onSave`; Cancel → nothing persisted, a confirm when dirty.
//
// It does not know about the note, the editor or asset ids beyond the request
// it was given: the host (PhotoAnnotatorHost) does the write.
//
// Modal behaviour: `aria-modal`, the whole workspace marked
// `data-annotation-editor` so the overlay's shortcut ownership rule
// (src/lib/pdfClipboard.js) keeps keys inside it, focus placed inside on open
// and returned inside whenever it falls to the body — a note's linked PDF
// editor may still be mounted (hidden) behind this workspace and must not
// receive Delete or Escape meant for it.
import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FaUndo, FaRedo, FaTrashAlt, FaObjectGroup, FaSearchMinus, FaSearchPlus, FaExpand } from "react-icons/fa";
import { loadAsset as readAssetBytes } from "../../lib/assetReader";
import { decodeImageSource } from "../../lib/imageProcessing";
import { renderAnnotatedImage } from "../../lib/imageAnnotationRaster";
import {
  IMAGE_PAGE_NO,
  IMAGE_ZOOM_STEPS,
  PHOTO_DECODE_MESSAGE,
  PHOTO_DEGRADED_NOTICE,
  PHOTO_DISCARD_CONFIRM,
  PHOTO_SAVE_ACTION,
  fitImageScale,
  imageAnnotationPage,
  imageOptionLimits,
  imageSizeFactor,
  imageZoomRange,
  photoAssetProblem,
  planPhotoAnnotationSave,
  resolvePhotoAnnotationSession,
} from "../../lib/photoAnnotation";
import { normalizeAnnotationList, serializeAnnotations } from "../../lib/pdfAnnotationModel";
import {
  ANNOTATION_SURFACE,
  TOOL,
  createToolStyles,
  isCreationTool,
  patchToolStyle,
  toolGroupsForSurface,
  toolStyleFor,
} from "../../pdf/pdfTools";
import { CLIPBOARD_SCOPE } from "../../lib/pdfClipboard";
import { clampScale, focalScroll, isZoomWheel, wheelZoomScale, zoomOptionsFor } from "../../lib/pdfZoom";
import useTransientMessage from "../../hooks/useTransientMessage";
import { actionButtonClass } from "../../lib/interactionStyles";
import PdfOptionsBar from "./PdfOptionsBar";
import { AnnotationToolButtons, ToolButton, ToolbarDivider } from "./AnnotationRibbon";
import "../../pdf/pdfLayers.css";

const PdfAnnotator = React.lazy(() => import("../../pdf/PdfAnnotator"));

const IMAGE_TOOL_GROUPS = toolGroupsForSurface(ANNOTATION_SURFACE.IMAGE);

/**
 * @param request  { assetId, annotationSourceId, alt } — what to annotate
 * @param onCancel () => void — close without persisting anything
 * @param onSave   async (result) => { ok, error } — persist; the dialog stays
 *                 open and reports `error` when it fails
 * @param deps     injectable platform calls (tests): loadAsset, decode, render
 */
export default function PhotoAnnotatorDialog({ request, onCancel, onSave, deps = {} }) {
  const { loadAsset = readAssetBytes, decode = decodeImageSource, render = renderAnnotatedImage } = deps;

  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [loadError, setLoadError] = useState(null);
  const [session, setSession] = useState(null); // { url, blob, mimeType, width, height, sourceAssetId, items, degraded }
  const [scale, setScale] = useState(1);
  const [zoomLabel, setZoomLabel] = useState(1);
  const [activeTool, setActiveTool] = useState(TOOL.SELECT);
  const [toolStyles, setToolStyles] = useState(null);
  const [selection, setSelection] = useState({ ids: [], items: [] });
  const [optionsFocusTick, setOptionsFocusTick] = useState(0);
  const [histState, setHistState] = useState({ canUndo: false, canRedo: false });
  const [hostEl, setHostEl] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [panning, setPanning] = useState(false);
  const notice = useTransientMessage();

  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const annotatorRef = useRef(null);
  const latestItemsRef = useRef([]);
  const initialItemsRef = useRef([]);
  const zoomTimer = useRef(null);
  const zoomLabelRef = useRef(1);
  const appliedScaleRef = useRef(1);
  const pendingFocalRef = useRef(null);
  const rangeRef = useRef(imageZoomRange(1));
  const objectUrlRef = useRef(null);

  const label = request?.alt || "photo";

  /* --------------------------------- Load --------------------------------- */

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setLoadError(null);
    (async () => {
      try {
        const imageRecord = await loadAsset(request.assetId);
        const problem = photoAssetProblem(imageRecord);
        if (problem) throw new Error(problem);
        // The original behind an annotated rendition, when there is one.
        const wanted =
          (imageRecord.metadata && imageRecord.metadata.annotation && imageRecord.metadata.annotation.sourceAssetId) ||
          request.annotationSourceId ||
          null;
        let sourceRecord = null;
        if (wanted && wanted !== request.assetId) {
          try {
            sourceRecord = await loadAsset(wanted);
          } catch {
            sourceRecord = null;
          }
        }
        const resolved = resolvePhotoAnnotationSession({
          imageRecord,
          sourceRecord,
          annotationSourceId: request.annotationSourceId,
        });
        const pixels = resolved.pixelsAssetId === imageRecord.id ? imageRecord : sourceRecord;
        if (!pixels) throw new Error(problem || PHOTO_DECODE_MESSAGE);
        let decoded;
        try {
          decoded = await decode(pixels.blob);
        } catch {
          throw new Error(PHOTO_DECODE_MESSAGE);
        }
        const width = decoded?.width;
        const height = decoded?.height;
        if (decoded?.release) decoded.release();
        if (!(width > 0) || !(height > 0)) throw new Error(PHOTO_DECODE_MESSAGE);
        if (cancelled) return;
        const url = URL.createObjectURL(pixels.blob);
        objectUrlRef.current = url;
        const items = normalizeAnnotationList(resolved.items);
        initialItemsRef.current = items;
        latestItemsRef.current = items;
        setToolStyles(createToolStyles({ sizeFactor: imageSizeFactor(width, height) }));
        setSession({
          url,
          blob: pixels.blob,
          mimeType: pixels.blob.type,
          width,
          height,
          sourceAssetId: resolved.sourceAssetId,
          items,
          degraded: resolved.degraded,
        });
        setDirty(false);
        setStatus("ready");
        if (resolved.degraded) notice.showInfo(PHOTO_DEGRADED_NOTICE);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err?.message || PHOTO_DECODE_MESSAGE);
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.assetId, request?.annotationSourceId]);

  // The object URL lives exactly as long as the workspace.
  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
      window.clearTimeout(zoomTimer.current);
    },
    []
  );

  const page = useMemo(
    () => (session ? imageAnnotationPage(session.width, session.height) : null),
    [session]
  );
  const sizeFactor = session ? imageSizeFactor(session.width, session.height) : 1;
  const limits = useMemo(() => imageOptionLimits(sizeFactor), [sizeFactor]);
  const pageEls = useMemo(() => (hostEl ? { [IMAGE_PAGE_NO]: hostEl } : {}), [hostEl]);

  /* --------------------------------- Zoom --------------------------------- */

  const requestScale = useCallback((next) => {
    const s = clampScale(next, rangeRef.current);
    zoomLabelRef.current = s;
    setZoomLabel(s);
    window.clearTimeout(zoomTimer.current);
    zoomTimer.current = window.setTimeout(() => setScale(s), 120);
  }, []);

  const fitScale = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !session) return 1;
    return fitImageScale(session, { viewportWidth: el.clientWidth, viewportHeight: el.clientHeight });
  }, [session]);

  // First layout after the photo resolves: fit it to the viewport, and size
  // the zoom range around that fit.
  useLayoutEffect(() => {
    if (status !== "ready" || !session) return;
    const fit = fitScale();
    rangeRef.current = imageZoomRange(fit);
    zoomLabelRef.current = fit;
    appliedScaleRef.current = fit;
    setZoomLabel(fit);
    setScale(fit);
  }, [status, session, fitScale]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || status !== "ready") return;
    function onWheel(e) {
      if (!isZoomWheel(e)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const focal = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (!pendingFocalRef.current) pendingFocalRef.current = { focal, from: appliedScaleRef.current };
      else pendingFocalRef.current.focal = focal;
      requestScale(wheelZoomScale(zoomLabelRef.current, e.deltaY, e.deltaMode, rangeRef.current));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [status, requestScale]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const pending = pendingFocalRef.current;
    appliedScaleRef.current = scale;
    if (!el || !pending) return;
    pendingFocalRef.current = null;
    const next = focalScroll(
      { scrollLeft: el.scrollLeft, scrollTop: el.scrollTop },
      pending.focal,
      pending.from,
      scale,
      rangeRef.current
    );
    el.scrollLeft = next.scrollLeft;
    el.scrollTop = next.scrollTop;
  }, [scale]);

  /* ------------------------------ Hand pan -------------------------------- */

  const panState = useRef(null);
  const onScrollAreaMouseDown = (e) => {
    if (activeTool !== TOOL.PAN || e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();
    panState.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    setPanning(true);
    const onMove = (ev) => {
      const p = panState.current;
      if (!p) return;
      el.scrollLeft = p.sl - (ev.clientX - p.x);
      el.scrollTop = p.st - (ev.clientY - p.y);
    };
    const onUp = () => {
      panState.current = null;
      setPanning(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /* --------------------------- Tools and options --------------------------- */

  const chooseTool = useCallback(
    (tool) => {
      if (tool === activeTool) {
        if (isCreationTool(tool)) setOptionsFocusTick((t) => t + 1);
        return;
      }
      setActiveTool(tool);
    },
    [activeTool]
  );
  const toolStyle = useMemo(
    () => toolStyleFor(toolStyles || {}, activeTool),
    [toolStyles, activeTool]
  );
  const onToolStyle = useCallback(
    (patch) => setToolStyles((prev) => patchToolStyle(prev || createToolStyles(), activeTool, patch)),
    [activeTool]
  );
  const applyToSelection = useCallback((patch) => annotatorRef.current?.applyToSelection(patch), []);
  const backToSelect = useCallback(() => setActiveTool(TOOL.SELECT), []);

  /* ------------------------- Dirty state and closing ----------------------- */

  // Only the overlay's COMMITTED mutations arrive here (one per completed
  // gesture, edit, paste or delete). Everything transient never does.
  const handleItemsChange = useCallback((items) => {
    const record = serializeAnnotations(items);
    latestItemsRef.current = record;
    setDirty(JSON.stringify(record) !== JSON.stringify(serializeAnnotations(initialItemsRef.current)));
  }, []);

  const requestClose = useCallback(() => {
    if (saving) return;
    if (dirty && !window.confirm(PHOTO_DISCARD_CONFIRM)) return;
    onCancel?.();
  }, [dirty, saving, onCancel]);

  // Escape reaches the overlay first (draft → gesture → selection); what is
  // left over comes here: a creation tool returns to Select, then Select
  // closes the workspace. Before the overlay exists (loading / error) the
  // workspace handles Escape itself.
  const onEscape = useCallback(() => {
    if (activeTool !== TOOL.SELECT) {
      setActiveTool(TOOL.SELECT);
      return;
    }
    requestClose();
  }, [activeTool, requestClose]);

  useEffect(() => {
    if (status === "ready") return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, requestClose]);

  // Focus lives inside the modal: placed on open, and returned whenever it
  // falls to the body (the overlay blurs a text box before a marquee).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.focus({ preventScroll: true });
    const onFocusOut = (e) => {
      if (e.relatedTarget && root.contains(e.relatedTarget)) return;
      window.setTimeout(() => {
        const active = document.activeElement;
        if (!root.isConnected) return;
        if (!active || active === document.body) root.focus({ preventScroll: true });
      }, 0);
    };
    root.addEventListener("focusout", onFocusOut);
    return () => root.removeEventListener("focusout", onFocusOut);
  }, []);

  /* --------------------------------- Save --------------------------------- */

  const onSaveClick = useCallback(async () => {
    if (saving || status !== "ready" || !session) return;
    const items = normalizeAnnotationList(annotatorRef.current?.getItems?.() ?? latestItemsRef.current);
    const plan = planPhotoAnnotationSave({
      initialItems: initialItemsRef.current,
      currentItems: items,
      currentAssetId: request.assetId,
      sourceAssetId: session.sourceAssetId,
    });
    setSaving(true);
    setSaveError(null);
    try {
      let result = {
        action: plan.action,
        items: plan.items,
        sourceAssetId: session.sourceAssetId,
        width: session.width,
        height: session.height,
        mimeType: session.mimeType,
        blob: null,
      };
      if (plan.action === PHOTO_SAVE_ACTION.RENDITION) {
        const rendered = await render({
          sourceBlob: session.blob,
          items: plan.items,
          mimeType: session.mimeType,
        });
        result = { ...result, blob: rendered.blob, width: rendered.width, height: rendered.height, mimeType: rendered.mimeType };
      }
      const outcome = await onSave?.(result);
      if (outcome && outcome.ok === false) {
        setSaveError(outcome.error || "The annotated photo could not be saved.");
        return;
      }
    } catch (err) {
      setSaveError(err?.message || "The annotated photo could not be saved.");
    } finally {
      setSaving(false);
    }
  }, [saving, status, session, request, render, onSave]);

  /* --------------------------------- Render -------------------------------- */

  const ready = status === "ready" && !!session && !!page;
  const zoomPct = Math.round(zoomLabel * 100);
  const zoomOptions = zoomOptionsFor(zoomLabel, IMAGE_ZOOM_STEPS, rangeRef.current);
  const hasSelection = selection.ids.length > 0;
  const w = page ? page.baseW * scale : 0;
  const h = page ? page.baseH * scale : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4">
      <div
        ref={rootRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Annotate photo: ${label}`}
        data-annotation-editor="true"
        data-photo-annotator="true"
        className="w-full max-w-6xl h-[92vh] flex flex-col min-h-0 bg-white dark:bg-[#1b1b1b] rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white truncate">Annotate photo</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {label}
              {session ? ` · ${session.width} × ${session.height} px` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              className={actionButtonClass({ className: "px-3 py-1.5 rounded-md text-sm", disabled: saving })}
              disabled={saving}
              onClick={requestClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className={actionButtonClass({
                primary: true,
                busy: saving,
                disabled: !ready || !dirty,
                className: "px-3 py-1.5 rounded-md text-sm",
              })}
              disabled={!ready || !dirty || saving}
              aria-disabled={!ready || !dirty || saving}
              onClick={onSaveClick}
              title={dirty ? "Save the annotated photo into the note" : "No changes to save"}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {/* The RIBBON: tools, then contextual options. Never scrolls. */}
        <div className="shrink-0" data-photo-ribbon="true">
          <div
            role="toolbar"
            aria-label="Photo annotation tools"
            className="flex items-center gap-1 p-2 border-b border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-[#222] flex-wrap"
          >
            <AnnotationToolButtons groups={IMAGE_TOOL_GROUPS} activeTool={activeTool} onChoose={chooseTool} disabled={!ready} />

            <ToolbarDivider />

            <ToolButton icon={<FaUndo />} label="Undo" disabled={!ready || !histState.canUndo} onClick={() => annotatorRef.current?.undo()} />
            <ToolButton icon={<FaRedo />} label="Redo" disabled={!ready || !histState.canRedo} onClick={() => annotatorRef.current?.redo()} />
            <ToolButton icon={<FaObjectGroup />} label="Select all annotations" disabled={!ready} onClick={() => annotatorRef.current?.selectAll()} />
            <ToolButton icon={<FaTrashAlt />} label="Delete selected" disabled={!ready || !hasSelection} onClick={() => annotatorRef.current?.deleteSelected()} />

            <div className="flex-1" />

            <ToolButton icon={<FaSearchMinus />} label="Zoom out" disabled={!ready} onClick={() => requestScale(zoomLabel / 1.25)} />
            <select
              className="text-sm px-1 py-1 rounded border bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600"
              value={zoomPct}
              disabled={!ready}
              onChange={(e) => requestScale(Number(e.target.value) / 100)}
              title="Zoom level (percent of the photo's native size)"
              aria-label="Zoom level"
            >
              {zoomOptions.map((z) => (
                <option key={z} value={z}>
                  {z}%
                </option>
              ))}
            </select>
            <ToolButton icon={<FaSearchPlus />} label="Zoom in" disabled={!ready} onClick={() => requestScale(zoomLabel * 1.25)} />
            <ToolButton icon={<FaExpand />} label="Fit photo" disabled={!ready} onClick={() => requestScale(fitScale())} />
          </div>

          <PdfOptionsBar
            tool={activeTool}
            toolStyle={toolStyle}
            onToolStyle={onToolStyle}
            selection={selection}
            onApply={applyToSelection}
            focusTick={optionsFocusTick}
            disabled={!ready}
            limits={limits}
          />
        </div>

        {/* Notices and errors — visible, never silent */}
        <div aria-live="polite" className="sr-only">
          {notice.message}
          {saveError}
        </div>
        {notice.message && (
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm border-b bg-gray-50 dark:bg-[#1d1d1d] text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700">
            <span>{notice.message}</span>
            <button type="button" className="text-xs underline shrink-0" onClick={notice.clear}>
              Dismiss
            </button>
          </div>
        )}
        {saveError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm border-b bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800"
          >
            <span>{saveError}</span>
            <button type="button" className="text-xs underline shrink-0" onClick={() => setSaveError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {/* The ONE scroller: the photo at the current zoom, the overlay over it. */}
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-auto p-4 bg-gray-200 dark:bg-[#111]"
          data-photo-scroller="true"
          style={{ cursor: activeTool === TOOL.PAN ? (panning ? "grabbing" : "grab") : undefined }}
          onMouseDown={onScrollAreaMouseDown}
        >
          {status === "loading" && (
            <div role="status" className="text-sm opacity-70 p-4">
              Loading photo…
            </div>
          )}
          {status === "error" && (
            <div role="alert" className="text-sm p-4 text-red-700 dark:text-red-300">
              {loadError}
            </div>
          )}
          {ready && (
            <div className="min-w-full min-h-full flex items-start justify-center">
              <div className="nw-pdf-page" data-photo-page="1" style={{ width: w, height: h }}>
                <img
                  src={session.url}
                  alt={label}
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                  style={{ position: "absolute", inset: 0, width: w, height: h, display: "block", userSelect: "none" }}
                />
                <div ref={setHostEl} className="nw-pdf-annot-host" />
              </div>
            </div>
          )}
          {ready && hostEl && (
            <Suspense fallback={null}>
              <PdfAnnotator
                ref={annotatorRef}
                pages={[page]}
                pageEls={pageEls}
                scale={scale}
                activeTool={activeTool}
                toolStyle={toolStyle}
                initialItems={session.items}
                onItemsChange={handleItemsChange}
                onHistoryChange={setHistState}
                onSelectionChange={setSelection}
                onToolConsumed={backToSelect}
                onEscape={onEscape}
                resolvePastePage={() => IMAGE_PAGE_NO}
                onNotice={notice.showInfo}
                clipboardScope={CLIPBOARD_SCOPE.IMAGE}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
