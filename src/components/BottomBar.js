// src/components/BottomBar.js
import React, { useRef, useState, useMemo, useEffect } from "react";
import {
  FaPlus,
  FaCamera,
  FaArrowUp,
  FaStar,
  FaUndo,
  FaTrash,
  FaPaperclip,
  FaMicrophone,
} from "react-icons/fa";
import StylePresetSelect from "./StylePresetSelect";
import { useRefine } from "../hooks/useRefine";
import { useAppState } from "../context/AppStateContext";
import {
  QUICK_ADD_KIND,
  canClearQuickAddTarget,
  canQuickAddText,
  quickAddChipDescription,
  quickAddChipLabel,
  quickAddInputLabel,
} from "../lib/quickAddTarget";
import {
  QUICK_ADD_SEND_ROUTE,
  STAGED_KIND,
  applyQuickAddSendResult,
  canSendQuickAddComposer,
  createQuickAddDraftStore,
  quickAddStagingEnabled,
  resolveQuickAddSendRoute,
  stagedAttachmentDisplayName,
  stagedAttachmentRemoveLabel,
} from "../lib/quickAddDraft";
import {
  ALLOWED_EDITOR_IMAGE_MIME_TYPES,
  validateEditorImageFile,
} from "../lib/editorImages";
import { IMAGE_DECODE_MESSAGE } from "../lib/imageProcessing";
import {
  ALLOWED_FILE_EXTENSIONS,
  ALLOWED_FILE_MIME_TYPES,
  FILE_INSERT_MESSAGE,
  bottomBarRouteFor,
  validateEditorFileAttachment,
} from "../lib/editorFileAttachments";
import exifr from "exifr";

// NEW: coordinate converter (offline-first, proj4-backed)
import {
  DEFAULT_COORD_SYSTEM,
  COORD_SYSTEM_OPTIONS,
  formatConvertedLineAsync,
} from "../lib/coordConverter";

// ---------- canvas helpers for stamped image ----------
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function wrapTextLines(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width <= maxWidth) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}
function loadImageFromBlobURL(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}
// ------------------------------------------------------

const STYLE_MEM_KEY = "sitewise-note-style-v1";
const COORD_SYS_KEY = "sitewise-coord-system-v1"; // per-note memory

function loadMap(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveMap(key, obj) {
  try {
    localStorage.setItem(key, JSON.stringify(obj));
  } catch {}
}

export default function BottomBar({
  editor,
  onInsertText,
  // Persistent image insertion, owned by MainArea:
  //   (sourceFile, { blob, name }) => Promise<void>
  // The stamped Blob is handed over rather than inserted here, so the bytes go
  // to IndexedDB and the note stores only a reference. This prop was previously
  // passed by MainArea but never accepted here, which is why photos were still
  // being inserted as object URLs that died at the next reload.
  onInsertImage,
  onImageError,     // (message) => void — pre-stamp rejection, one message channel
  // Persistent FILE attachment, owned by MainArea:
  //   (file) => Promise<void>
  // Every non-image selection goes here. Nothing in this bar writes a `blob:`
  // URL into the note any more: the previous path created an object URL, handed
  // it to insertContent (where TipTap's own protocol check silently dropped the
  // href) and revoked it 15 seconds later, so an attached document was
  // unreachable almost immediately and gone for good after a reload.
  onInsertFile,
  onFileError,      // (message) => void — same one message channel
  disabled = false,
  // ---------------------------- Quick Add ---------------------------------
  // WHERE this bar's captures go, resolved by MainArea (see
  // src/lib/quickAddTarget.js). This bar describes and gates the destination;
  // it never chooses one, and clicking a Template row never moves focus here.
  target = null,
  capture = null,        // { image, file, reason } — schema capability of the target
  targetToken = null,    // comparable identity, for stale async captures
  onClearTarget,         // () => void — Template destinations only
  onCaptureInsertPoint,  // () => snapshot — the Free-form caret, at action start
  // FREE-FORM ONLY. Delivers one whole composition — the staged attachments and
  // the typed text together — as a single operation, resolving the destination
  // once at Send:
  //   ({ text, attachments }) => Promise<{ ok, deliveredIds, textDelivered, stale }>
  // The composer clears only what `deliveredIds` says actually landed.
  onSendComposer,
  // The AI WRITING STYLE the user has selected, reported upward whenever it
  // changes (and on note restore).
  //
  // The control is presented as "AI writing style" — a general choice, not a
  // composer-only one — but the note-level Refine lives in MainArea and had no
  // way to see it, so it always sent the default preset. Selecting "Summary"
  // and pressing Refine therefore produced a concise-professional rewrite, and
  // three of the four modes never reached the provider at all.
  //
  //   (style) => void
  onStyleChange,
  // LIVE TRANSCRIPT. The composer records nothing itself any more: its
  // microphone is a shortcut that opens the ONE Live Transcript workspace
  // (sidebar → Capture → Live transcript, LiveTranscriptProvider) — the same
  // session, never a second recorder. `(triggerElement) => void`.
  onOpenLiveTranscript,
  // Whether that session is recording right now — the shortcut shows it.
  liveTranscriptRecording = false,
  // Reports whether an unsent composition (text or staged attachments) exists,
  // so a collapsed composer's handle can say a draft is kept.
  //   (hasComposition: boolean) => void
  onCompositionChange,
}) {
  const { currentNoteId } = useAppState();

  // Draft / refine state
  const [input, setInput] = useState("");
  const [refinedDraft, setRefinedDraft] = useState(null);
  const [originalBeforeRefine, setOriginalBeforeRefine] = useState(null);

  // Busy states
  const [busy, setBusy] = useState(false);
  // The composer's own inline failure line (an AI refine that could not run).
  const [composerError, setComposerError] = useState("");
  // A composer Send in flight. Separate from `busy` (AI refine) so a delivery
  // cannot be started twice and cannot be confused with a refinement.
  const [sending, setSending] = useState(false);

  /* ------------------------- Staged attachments ---------------------------- */
  //
  // Choosing an image or a file STAGES it here; it reaches the note only on
  // Send, together with whatever text the user typed to accompany it. Nothing
  // in this queue is persisted anywhere — no note write, no attachment
  // reference, no IndexedDB asset — see src/lib/quickAddDraft.js.
  //
  // BOTH destinations compose this way: the Free-form note and a SELECTED
  // Template row. A Template row's composition is appended to that row's
  // ordered section content at Send; nothing is written to it while the user is
  // still assembling one.
  const draftStoreRef = useRef(null);
  if (draftStoreRef.current === null) {
    draftStoreRef.current = createQuickAddDraftStore();
  }
  // A render mirror of the store, which is deliberately not React state: the
  // object-URL lifecycle has to be exact, and that belongs in one testable unit
  // rather than spread across effects.
  const [stagedAttachments, setStagedAttachments] = useState([]);
  const syncStaged = () => setStagedAttachments(draftStoreRef.current.list());
  const clearStaged = () => {
    if (draftStoreRef.current.clear() > 0) syncStaged();
  };

  // Style preset (per note memory)
  const [stylePreset, setStylePreset] = useState("concise, professional");

  // NEW: coordinate system state (default Mount Eden 2000)
  const [coordSystem, setCoordSystem] = useState(DEFAULT_COORD_SYSTEM);

  // Refs
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  // The LIVE destination, readable from a transcription that started before the
  // user moved. Kept in a ref because the async handler closed over the value
  // that was current when recording began — which is exactly the value it must
  // compare against, not silently reuse.
  const targetTokenRef = useRef(targetToken);
  targetTokenRef.current = targetToken;

  // Hooks
  const { refineText } = useRefine();

  // Derived
  const currentText = refinedDraft ?? input;
  const hasText = useMemo(() => currentText.trim().length > 0, [currentText]);
  const isDisabled = disabled || busy || sending;

  /* ------------------------------ Quick Add ------------------------------- */

  // Everything the bar says about its destination comes from one pure model, so
  // the chip, the placeholder, the accessible name and the Send gate can never
  // disagree about where a capture would land.
  const chipLabel = quickAddChipLabel(target);
  const chipDescription = quickAddChipDescription(target);
  // One fixed placeholder — the destination is stated once, by the chip in
  // the status row (and by the Send button's own tooltip/accessible name),
  // never repeated here.
  const placeholder = "Type, paste, or add media…";
  const inputLabel = quickAddInputLabel(target);
  const showClearTarget = canClearQuickAddTarget(target) && !!onClearTarget;

  // A Template form with no row selected may not send: a guessed destination
  // would write into an arbitrary field of somebody's report.
  const canSend = canQuickAddText(target);

  // Which destinations compose (stage now, deliver at Send) — the Free-form
  // note and a SELECTED Template row. Decided in one place so this gate and the
  // Send route below cannot disagree; see src/lib/quickAddDraft.js.
  const stagingEnabled = quickAddStagingEnabled({
    target,
    hasComposerHandler: typeof onSendComposer === "function",
  });

  // A Template row's typed/dictated text is part of the same composition as its
  // attachments: it becomes a text item appended to that row's ordered section
  // content, not an insertion at the caret of whatever row editor is open. So it
  // takes the composer route even when nothing is staged.
  const textUsesComposer = target?.kind === QUICK_ADD_KIND.TEMPLATE_ROW;

  // An attachment on its own is a complete capture, so Send does not require
  // text once something is staged.
  const canSubmit = canSendQuickAddComposer({
    hasText,
    attachmentCount: stagedAttachments.length,
    canSendText: canSend,
  });
  const hasComposition = hasText || stagedAttachments.length > 0;
  // Tell the owner whether a draft exists (used only to word the collapsed
  // composer's handle — the draft itself never leaves this component).
  useEffect(() => {
    if (typeof onCompositionChange === "function") onCompositionChange(hasComposition);
  }, [hasComposition, onCompositionChange]);

  const canCaptureImage = !!capture?.image;
  const canCaptureFile = !!capture?.file;
  const canCaptureAnything = canCaptureImage || canCaptureFile;
  // Why capture is unavailable, when it is — used as the control's tooltip so
  // a disabled button explains itself rather than just being dead.
  const captureReason = capture?.reason || null;

  // The picker HINT only. It is user-controlled and any file can be dropped
  // past it, so it decides nothing — validation always happens against the file
  // itself, and the destination's own field type is re-checked on arrival.
  const captureAccept = useMemo(() => {
    const parts = [];
    // The explicit image list rather than a wildcard: it is what the image path
    // actually accepts (JPEG/PNG/WebP — SVG is excluded as a scriptable
    // document), so the picker stops offering files that would only be rejected.
    if (canCaptureImage) parts.push(...ALLOWED_EDITOR_IMAGE_MIME_TYPES);
    if (canCaptureFile) {
      parts.push(...ALLOWED_FILE_MIME_TYPES, ...ALLOWED_FILE_EXTENSIONS);
    }
    return parts.join(",");
  }, [canCaptureImage, canCaptureFile]);

  const captureLabel = canCaptureImage
    ? canCaptureFile
      ? "Add an image or a file"
      : `Add image${chipLabel ? ` to ${chipLabel}` : ""}`
    : canCaptureFile
    ? `Add file${chipLabel ? ` to ${chipLabel}` : ""}`
    : "Add image or file";

  // Snapshot of where a capture that BEGINS now should land. Read once, at the
  // start of the action, and carried through the asynchronous work.
  const snapshotInsertPoint = () =>
    typeof onCaptureInsertPoint === "function" ? onCaptureInsertPoint() : undefined;


  // An unsent attachment belongs to the composition it was staged for. Opening
  // another note must not carry it along — it would then be sent into a note it
  // was never meant for — so the queue is dropped and every preview URL revoked.
  // This complements, and does not replace, MainArea's own target reset.
  useEffect(() => {
    clearStaged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNoteId]);

  // The same rule for the DESTINATION itself. `targetToken` is the comparable
  // identity of where a capture would land — note, view, kind and Template row —
  // so this one effect covers leaving the Free-form view, selecting a different
  // Template row, clearing the target, and losing it altogether.
  //
  // Drafts intended for one section must never silently land in another, and the
  // safe resolution is to drop them rather than to retarget them: the user
  // staged a photo FOR a particular section, and re-aiming it somewhere else is
  // the one outcome worse than making them pick it again.
  useEffect(() => {
    clearStaged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetToken]);

  // Unmount: the store owns every live preview URL, so this is the one place
  // that can guarantee none outlive the component.
  useEffect(() => {
    const store = draftStoreRef.current;
    return () => store.clear();
  }, []);

  // Load per-note memory when note changes
  useEffect(() => {
    const styleMap = loadMap(STYLE_MEM_KEY);
    const sysMap = loadMap(COORD_SYS_KEY);

    if (currentNoteId) {
      setStylePreset(styleMap[currentNoteId] || "concise, professional");
      setCoordSystem(sysMap[currentNoteId] || DEFAULT_COORD_SYSTEM);
    } else {
      setStylePreset("concise, professional");
      setCoordSystem(DEFAULT_COORD_SYSTEM);
    }
  }, [currentNoteId]);

  // Persist style/system when changed. (The transcription language is no
  // longer this component's: see src/lib/transcriptionLanguage.js.)
  useEffect(() => {
    if (!currentNoteId) return;
    const styleMap = loadMap(STYLE_MEM_KEY);
    styleMap[currentNoteId] = stylePreset || "concise, professional";
    saveMap(STYLE_MEM_KEY, styleMap);
  }, [currentNoteId, stylePreset]);

  // The selected style, reported to the owner of the note-level Refine. Held in
  // a ref so a parent that hands down a fresh callback on every render cannot
  // turn this into a render loop; the effect reacts to the STYLE changing.
  const onStyleChangeRef = useRef(onStyleChange);
  onStyleChangeRef.current = onStyleChange;
  useEffect(() => {
    onStyleChangeRef.current?.(stylePreset);
  }, [stylePreset]);

  useEffect(() => {
    if (!currentNoteId) return;
    const sysMap = loadMap(COORD_SYS_KEY);
    sysMap[currentNoteId] = coordSystem || DEFAULT_COORD_SYSTEM;
    saveMap(COORD_SYS_KEY, sysMap);
  }, [currentNoteId, coordSystem]);

  // ---------------- EXIF / GPS helpers ----------------
  async function getExifGeoAndTime(file) {
    try {
      const gps = await exifr.gps(file).catch(() => null);
      const tags = await exifr.parse(file, ["DateTimeOriginal"]).catch(() => null);
      const lat = gps?.latitude ?? null;
      const lon = gps?.longitude ?? null;
      const exifDate = tags?.DateTimeOriginal instanceof Date ? tags.DateTimeOriginal : null;
      return { lat, lon, exifDate, altitude: gps?.altitude ?? null };
    } catch {
      return { lat: null, lon: null, exifDate: null, altitude: null };
    }
  }
  function formatLocalWithTz(dt) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        hour12: true,
        timeZoneName: "short",
      }).format(dt);
    } catch {
      return new Date(dt).toLocaleString();
    }
  }
  function getBrowserGeo(timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!navigator?.geolocation?.getCurrentPosition) return resolve(null);
      const opts = { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 };
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy, altitude, speed } = pos.coords || {};
          if (typeof latitude === "number" && typeof longitude === "number") {
            resolve({
              lat: latitude, lon: longitude,
              acc: accuracy ?? null,
              alt: typeof altitude === "number" ? altitude : null,
              spd: typeof speed === "number" ? speed : null,
            });
          } else {
            resolve(null);
          }
        },
        () => resolve(null),
        opts
      );
    });
  }
  async function reverseGeocode(lat, lon) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const a = data?.address || {};
      const line1 = [a.house_number, a.road].filter(Boolean).join(" ").trim() || null;
      const line2 = a.suburb || a.neighbourhood || a.locality || null;
      const line3 = a.city || a.town || a.village || a.county || null;
      const line4 = a.state || a.region || a.province || null;
      return [line1, line2, line3, line4].filter(Boolean);
    } catch {
      return null;
    }
  }

  // Map thumbnail (bottom-right, zoom 12)
  async function drawMapThumbnail(ctx, imgW, imgH, lat, lon) {
    if (lat == null || lon == null) return;

    const base = Math.round(Math.min(Math.max(imgW * 0.18, 140), 260));
    const mapSize = base;
    const margin = Math.max(10, Math.round(imgW * 0.01));
    const x = imgW - mapSize - margin;
    const y = imgH - mapSize - margin;   // bottom-right corner
    const radius = Math.round(mapSize * 0.08);

    const dpr = window.devicePixelRatio || 1;
    const width = mapSize;
    const height = mapSize;
    const key = process.env.REACT_APP_GOOGLE_MAPS_KEY;

    let url;
    if (key) {
      const scale = dpr >= 2 ? 2 : 1;
      const marker = `color:red|${lat},${lon}`;
      url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=12&size=${width}x${height}&scale=${scale}&maptype=roadmap&markers=${encodeURIComponent(marker)}&key=${key}`;
    } else {
      url = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=12&size=${width}x${height}&markers=${lat},${lon},lightred1`;
    }

    const mapImg = await (async () => {
      try {
        return await loadImageFromBlobURL(url);
      } catch {
        return null;
      }
    })();
    if (!mapImg) return;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = Math.max(6, Math.round(mapSize * 0.06));
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    roundRectPath(ctx, x, y, mapSize, mapSize, radius);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRectPath(ctx, x, y, mapSize, mapSize, radius);
    ctx.clip();
    ctx.drawImage(mapImg, x, y, mapSize, mapSize);
    ctx.restore();

    ctx.save();
    roundRectPath(ctx, x, y, mapSize, mapSize, radius);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = Math.max(2, Math.round(mapSize * 0.02));
    ctx.stroke();
    ctx.restore();
  }

  // `outputType` keeps the stamped result in the SOURCE photo's format: the
  // canvas would otherwise always emit PNG, turning an ordinary JPEG capture
  // into a far larger file for no visible gain.
  async function buildStampedImageBLOB(file, outputType = "image/png") {
    const originalURL = URL.createObjectURL(file);
    let img;
    try { img = await loadImageFromBlobURL(originalURL); }
    finally { URL.revokeObjectURL(originalURL); }

    const { lat: exifLat, lon: exifLon, exifDate, altitude: exifAlt } = await getExifGeoAndTime(file);
    let lat = exifLat, lon = exifLon, acc = null, alt = exifAlt, spdMs = null;

    if (lat == null || lon == null || alt == null) {
      const browserGeo = await getBrowserGeo(8000);
      if (browserGeo) {
        lat = lat ?? browserGeo.lat;
        lon = lon ?? browserGeo.lon;
        // eslint-disable-next-line no-unused-vars
        acc = browserGeo.acc ?? null;
        alt = alt ?? browserGeo.alt;
        spdMs = browserGeo.spd;
      }
    }

    const indexNo = (Number(localStorage.getItem("sitewise_photo_index") || "0") || 0) + 1;
    localStorage.setItem("sitewise_photo_index", String(indexNo));

    const networkDt = exifDate || new Date();
    const localDt = new Date();
    const networkStr = formatLocalWithTz(networkDt);
    const localStr = formatLocalWithTz(localDt);

    // Reverse geocode (best-effort)
    let addrLines = null;
    if (lat != null && lon != null) addrLines = await reverseGeocode(lat, lon);

    const coordStr = lat != null && lon != null ? `${lat.toFixed(6)}, ${lon.toFixed(6)}` : null;

    // NEW: offline conversion under the Coordinates line
    const convertedStr =
      lat != null && lon != null
        ? await formatConvertedLineAsync(coordSystem, lat, lon)
        : null;

    let altDisplay = "n/a";
    if (typeof alt === "number" && isFinite(alt) && Math.abs(alt) >= 1) altDisplay = `${alt.toFixed(1)}m`;
    const spdDisplay = typeof spdMs === "number" ? `${(spdMs * 3.6).toFixed(1)}km/h` : "0.0km/h";

    const lines = [
      `network: ${networkStr}`,
      `Local: ${localStr}`,
    ];
    if (addrLines && addrLines.length) lines.push(...addrLines);
    if (coordStr) lines.push(`Coordinates: ${coordStr}`);
    if (convertedStr) lines.push(convertedStr); // directly underneath
    lines.push(`Altitude: ${altDisplay}`);
    lines.push(`speed: ${spdDisplay}`);
    lines.push(`index number ${indexNo}`);

    // Prepare canvas and draw
    const stampedCanvas = document.createElement("canvas");
    const maxW = img.width, maxH = img.height;
    stampedCanvas.width = maxW; stampedCanvas.height = maxH;
    const ctx = stampedCanvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, maxW, maxH);

    // Left info box
    const padX = 10, padY = 10;
    const boxW = Math.round(Math.min(0.35 * maxW, 400));
    const fontSize = Math.max(12, Math.round(maxW * 0.012));
    ctx.font = `${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textBaseline = "top";
    const lineHeight = Math.round(fontSize * 1.25);
    const wrapped = [];
    for (const raw of lines) wrapped.push(...wrapTextLines(ctx, raw, boxW - padX * 2));
    const textH = wrapped.length * lineHeight;
    const boxH = textH + padY * 2;
    const boxX = 10;
    const boxY = Math.max(10, maxH - boxH - 10);

    ctx.save();
    roundRectPath(ctx, boxX, boxY, boxW, boxH, 8);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "#fff";
    let ty = boxY + padY;
    for (const l of wrapped) { ctx.fillText(l, boxX + padX, ty); ty += lineHeight; }

    // Map thumbnail (bottom-right, zoom 12)
    await drawMapThumbnail(ctx, maxW, maxH, lat, lon);

    const stampedBlob = await new Promise((resolve) =>
      stampedCanvas.toBlob(resolve, outputType, 0.92)
    );
    return stampedBlob;
  }

  /* ------------------ CAMERA vs ORDINARY UPLOAD — the split ---------------- */
  //
  // The ONE place this bar decides what an image's bytes are, and the ONE place
  // the stamping pipeline is reached from.
  //
  //   CAMERA CAPTURE  -> stamped. The photo the user just TOOK is documentary
  //                      evidence, and the existing burnt-in info box (time,
  //                      address, coordinates, altitude, index) plus the map
  //                      thumbnail is exactly what makes it usable as such. That
  //                      behaviour is unchanged, layout included.
  //   `+` PICKER      -> NOT stamped. An image the user CHOSE off their device
  //                      is an ordinary picture: a diagram, a screenshot, a
  //                      manufacturer's photo. Stamping it would burn today's
  //                      location into a file that has nothing to do with here,
  //                      and — because the stamp asks for geolocation — would
  //                      also make choosing a picture prompt for location
  //                      permission. Both routed through the stamping path
  //                      before this phase; that was the bug.
  //
  // Ordinary uploads therefore never call buildStampedImageBLOB, and since every
  // geolocation / reverse-geocode / map request lives inside it, they never ask
  // for location either. No structured GPS/address metadata is produced by
  // either route: the camera stamp is, and stays, visible pixels in the Blob.
  //
  // `stamp` is passed explicitly by each call site rather than inferred from the
  // file, because a file cannot say how it was obtained — only the control the
  // user pressed knows that.
  async function preparePhotoBytes(file, { stamp }) {
    // The 20 MB source limit is applied to the picked file FIRST, before any
    // expensive decode/stamp work — and to the file the user actually chose,
    // never to our own derived canvas output.
    const check = validateEditorImageFile(file);
    if (!check.ok) {
      onImageError?.(check.error);
      return null;
    }
    if (!stamp) {
      // The picked file, untouched. No location, no map, no labels.
      return { blob: file, mimeType: check.mimeType };
    }
    let stamped = null;
    try {
      stamped = await buildStampedImageBLOB(file, check.mimeType);
    } catch {
      onImageError?.(IMAGE_DECODE_MESSAGE);
      return null;
    }
    // A failed stamp — geolocation denied, the map thumbnail unavailable, a
    // canvas that produced nothing — falls back to the original photo rather
    // than losing the capture. buildStampedImageBLOB already treats a missing
    // position and an unreachable map tile as omissions rather than errors, so
    // a camera capture stays usable in all three cases.
    return { blob: stamped || file, mimeType: check.mimeType };
  }

  // The ONE image insertion path for this bar. It never touches the editor
  // itself: the Blob goes to MainArea, which stores it in IndexedDB and inserts
  // a reference only once that write is confirmed. Nothing here writes a blob:
  // URL into the note.
  async function insertPhoto(file, insertPoint, { stamp }) {
    if (!onInsertImage) return;
    const prepared = await preparePhotoBytes(file, { stamp });
    if (!prepared) return;
    await onInsertImage(file, {
      blob: prepared.blob,
      name: file.name,
      // Where this capture was aimed when the user picked the file. Validated
      // again on arrival — a document edited during the stamp invalidates it.
      insertPoint,
    });
  }
  // ----------------------------------------------------------

  // Clears the TEXT half of the composition. Staged attachments are separate:
  // a partially delivered Send removes only what actually landed.
  const clearTextDraft = () => {
    setInput("");
    setRefinedDraft(null);
    setOriginalBeforeRefine(null);
    setComposerError("");
  };

  const handleSend = async () => {
    if (sending) return;
    const text = (refinedDraft ?? input).trim();

    // Read the queue from the STORE, not from render state, so a staging that
    // has not yet re-rendered cannot be missed.
    const staged = draftStoreRef.current.list();

    // One decision, in one place: any staged attachment ALWAYS goes through the
    // composer, whether or not there is text. Text is never delivered
    // separately from the attachments it was written to describe.
    const route = resolveQuickAddSendRoute({
      attachmentCount: staged.length,
      hasText: !!text,
      // No destination, no send. The placeholder already asks for a row, so
      // this is the second half of the same rule rather than a surprise.
      canSendText: canSend,
      hasComposerHandler: typeof onSendComposer === "function",
      // A Template row composes its text too — it becomes a section text item
      // appended at the end, not an insertion at a row editor's caret.
      textUsesComposer,
    });

    if (route === QUICK_ADD_SEND_ROUTE.NONE) return;

    // Text-only — the original path, unchanged. Nothing about it moved into the
    // composer pipeline, so cursor targeting, the end-of-note fallback and the
    // refine/voice draft semantics behave exactly as they always have.
    if (route === QUICK_ADD_SEND_ROUTE.TEXT_ONLY) {
      if (!onInsertText || !editor) return;
      // The draft is cleared ONLY on a confirmed insertion. A refused send — no
      // row selected, a row that no longer exists — must leave the user's typed
      // or dictated text exactly where it is.
      const delivered = onInsertText(text);
      if (delivered === false) return;
      clearTextDraft();
      return;
    }

    setSending(true);
    let result;
    try {
      // The DESTINATION IS RESOLVED HERE, not when the files were chosen. The
      // user may have staged a photo, kept working and moved the caret since;
      // whatever the Free-form insertion-point system says now is authoritative.
      result = await onSendComposer({ text, attachments: staged });
    } catch {
      result = null;
    } finally {
      setSending(false);
    }

    // Drop exactly what the delivery reports — never more. An item that failed,
    // or that was never reached, stays staged so it can be retried, and one
    // that already landed cannot be delivered twice.
    const { deliveredIds, clearText } = applyQuickAddSendResult(result, {
      hasText: !!text,
    });
    if (deliveredIds.length > 0) {
      draftStoreRef.current.removeMany(deliveredIds);
      syncStaged();
    }
    if (clearText) clearTextDraft();
  };

  // The trash clears the whole UNSENT composition: typed draft, refine state,
  // staged attachments and their preview URLs. It never touches anything that
  // has already been inserted into the note.
  const clearDraft = () => {
    clearTextDraft();
    clearStaged();
  };

  /* ------------------------------- Staging --------------------------------- */

  // A photo chosen or captured for the current composition. All of the image
  // work — validation and, for the camera only, the whole existing stamping
  // pipeline (EXIF/GPS, reverse geocode, map thumbnail, re-encode) — happens
  // HERE, and its FINAL Blob is what gets staged. So Send does no image work at
  // all, there is no second photo-processing path, and the preview the user sees
  // in the composer is the image that will actually be stored.
  //
  // Nothing is persisted: the payload lives in memory and the preview is an
  // object URL the draft store owns and revokes.
  async function stagePhoto(file, { stamp }) {
    const prepared = await preparePhotoBytes(file, { stamp });
    if (!prepared) return;
    draftStoreRef.current.add({
      kind: STAGED_KIND.IMAGE,
      payload: prepared.blob,
      name: file.name,
      // The type validated from the file the user actually picked, carried
      // forward so Send never re-measures our own derived output against the
      // source-input size limit.
      mimeType: prepared.mimeType,
    });
    syncStaged();
  }

  // A document chosen for the current composition. Validated HERE, before
  // staging, so an unsupported or oversized file is refused while the user is
  // still composing rather than at Send. The destination's own write sequence
  // validates it again on delivery against ITS policy — this is an early check,
  // not a replacement for that one.
  function stageAttachedFile(file) {
    const check = validateEditorFileAttachment(file);
    if (!check.ok) {
      onFileError?.(check.error);
      return;
    }
    draftStoreRef.current.add({
      kind: STAGED_KIND.FILE,
      payload: file,
      name: file.name,
      mimeType: check.mimeType,
    });
    syncStaged();
  }

  const removeStagedAttachment = (id) => {
    if (draftStoreRef.current.remove(id)) syncStaged();
  };

  // The ONE non-image insertion path for this bar. It hands the picked file to
  // MainArea, which validates it, stores the bytes in IndexedDB and inserts a
  // reference only once that write is confirmed. Nothing is inserted here.
  //
  // A PDF selected through THIS picker becomes a Free-form attachment card. It
  // is deliberately NOT imported into the global PDF workspace: that is the
  // dedicated Note → PDF workflow's job, and it is unchanged.
  async function insertAttachedFile(file, insertPoint) {
    if (!onInsertFile) {
      onFileError?.(FILE_INSERT_MESSAGE);
      return;
    }
    await onInsertFile(file, { insertPoint });
  }

  const handleFilesSelected = async (e) => {
    const files = Array.from(e.target.files || []);
    // Reset the input up front: the loop below awaits, and a picker that still
    // holds the previous selection will not re-fire for the same file.
    e.target.value = "";
    // A cancelled picker yields no files: nothing happens and nothing is said.

    // Selection STAGES. Nothing reaches the note until Send, which is what makes
    // "photo, then the sentence describing it" composable at all. No insertion
    // point is snapshotted here — staging is not delivery, and the destination
    // is resolved at Send from wherever the user is by then.
    //
    // `stamp: false` — this is the ORDINARY upload picker. A picture chosen off
    // the device stays a normal picture: no location is requested, no map is
    // drawn and no camera labels are burnt into it.
    if (stagingEnabled) {
      for (const f of files) {
        if (bottomBarRouteFor(f) === "image") {
          await stagePhoto(f, { stamp: false });
          continue;
        }
        stageAttachedFile(f);
      }
      return;
    }

    // No composing destination (no note, or a Template form with no row
    // selected — where both capture controls are disabled anyway): the original
    // immediate insertion, and still unstamped for a picked image.
    const insertPoint = snapshotInsertPoint();
    for (const f of files) {
      if (bottomBarRouteFor(f) === "image") {
        await insertPhoto(f, insertPoint, { stamp: false });
        continue;
      }
      await insertAttachedFile(f, insertPoint);
    }
  };

  const handleCameraSelected = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;

    // The camera stages into the same queue as the picker, but with `stamp:
    // true` — a real capture keeps the existing burnt-in info box and map
    // thumbnail. The STAMPED Blob is what is staged, previewed and, at Send,
    // persisted; the unstamped original is never stored.
    if (stagingEnabled) {
      if (bottomBarRouteFor(f) !== "image") {
        // A device that hands back something that is not an image must not lose
        // the file; it is staged as a document instead — and a document is
        // never stamped.
        stageAttachedFile(f);
        return;
      }
      await stagePhoto(f, { stamp: true });
      return;
    }

    const insertPoint = snapshotInsertPoint();
    if (bottomBarRouteFor(f) !== "image") {
      // The camera is an image path, but a device that hands back something
      // else must not lose the file to a temporary link. It goes through the
      // same persistent attachment path, which accepts it or says why not.
      await insertAttachedFile(f, insertPoint);
      return;
    }
    await insertPhoto(f, insertPoint, { stamp: true });
  };

  // ---------------- Live transcript shortcut ----------------
  // The composer no longer records or transcribes on its own (that second
  // recorder is gone): the microphone opens the ONE Live Transcript
  // workspace, whose session is owned by LiveTranscriptProvider.
  const handleVoiceClick = (e) => {
    if (typeof onOpenLiveTranscript === "function") onOpenLiveTranscript(e.currentTarget);
  };
  // ----------------------------------------------------------

  // AI refine. refineText returns a structured outcome (see useRefine): an
  // unavailable or failed request must leave the draft exactly as the user
  // left it and must never be shown as a refinement. `busy` is what prevents
  // a duplicate submission; there is no automatic retry.
  const runRefine = async () => {
    const text = (refinedDraft ?? input).trim();
    if (!text || busy) return;

    setBusy(true);
    setComposerError("");
    const result = await refineText({ text, style: stylePreset });
    setBusy(false);

    if (!result.ok) {
      // Nothing is written back: no draft change, and no revert point, so the
      // Revert control cannot offer to undo something that never happened.
      setComposerError(result.message);
      return;
    }

    if (originalBeforeRefine == null) setOriginalBeforeRefine(input);
    setRefinedDraft(result.refined);
  };
  const revertRefine = () => {
    if (refinedDraft == null) return;
    setRefinedDraft(null);
    if (originalBeforeRefine != null) setInput(originalBeforeRefine);
    setOriginalBeforeRefine(null);
  };

  return (
    <div className="px-2 pb-2">
      <div
        className={[
          "relative w-full rounded-2xl",
          "bg-gray-100 dark:bg-[#2a2a2a]",
          "border border-gray-300 dark:border-gray-700",
          "px-3 pt-3 pb-12",
        ].join(" ")}
      >
        {/* STAGED ATTACHMENTS — held by the composer, not yet in the note.
            They wrap rather than overflowing, stay visually subordinate to the
            document, and each one carries its own named remove control. */}
        {stagedAttachments.length > 0 && (
          <ul
            className="nw-quickadd-staged"
            aria-label={`Attachments waiting to be sent (${stagedAttachments.length})`}
          >
            {stagedAttachments.map((item) => {
              const displayName = stagedAttachmentDisplayName(item);
              return (
                <li key={item.id} className="nw-quickadd-staged-item">
                  {item.kind === STAGED_KIND.IMAGE && item.previewUrl ? (
                    <img
                      className="nw-quickadd-staged-thumb"
                      src={item.previewUrl}
                      // Decorative: the filename beside it already carries the
                      // accessible information, so announcing it twice would
                      // only make the list harder to read.
                      alt=""
                    />
                  ) : (
                    <span className="nw-quickadd-staged-icon" aria-hidden="true">
                      {item.kind === STAGED_KIND.IMAGE ? <FaCamera /> : <FaPaperclip />}
                    </span>
                  )}
                  <span className="nw-quickadd-staged-name" title={displayName}>
                    {displayName}
                  </span>
                  <button
                    type="button"
                    className="nw-quickadd-staged-remove"
                    onClick={() => removeStagedAttachment(item.id)}
                    disabled={sending}
                    aria-label={stagedAttachmentRemoveLabel(item)}
                    title={stagedAttachmentRemoveLabel(item)}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <textarea
          className="w-full resize-none bg-transparent outline-none text-sm text-black dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
          placeholder={placeholder}
          aria-label={inputLabel}
          rows={5}
          disabled={disabled}
          value={currentText}
          onChange={(e) => {
            if (refinedDraft != null) setRefinedDraft(e.target.value);
            else setInput(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 320) + "px";
          }}
          style={{ height: 120, maxHeight: 320, overflow: "auto" }}
        />

        {/* Status row (left) */}
        <div className="absolute left-3 bottom-2 flex items-center gap-3">
          <StylePresetSelect
            value={stylePreset}
            onChange={setStylePreset}
            disabled={isDisabled}
          />

          {/* DESTINATION CHIP — where Quick Add sends this capture. The one
              place this is stated: no "Quick Add to" label repeats the
              feature's own name (the collapsible header already carries it),
              and no second mention sits above the textarea. Restrained,
              truncates a long row name in CSS while the title and the
              accessible description keep the full text. */}
          {!!chipLabel && (
            <span
              className="nw-quickadd-chip"
              title={chipDescription}
              aria-label={chipDescription}
            >
              <span className="nw-quickadd-chip-label">{chipLabel}</span>
              {showClearTarget && (
                <button
                  type="button"
                  className="nw-quickadd-chip-clear"
                  onClick={onClearTarget}
                  aria-label="Clear Quick Add target"
                  title="Clear Quick Add target"
                >
                  <span aria-hidden="true">×</span>
                </button>
              )}
            </span>
          )}

          {/* Converter dropdown (no label, no button). Same shared field class
              and same padding/radius/type scale as the two selects beside it,
              so the three read as one family. The bare `border` utility is
              dropped: the field class owns the border in every state. */}
          <select
            className="nw-field px-2 py-1 text-xs rounded"
            value={coordSystem}
            onChange={(e) => setCoordSystem(e.target.value)}
            disabled={isDisabled}
            title="Choose coordinate system for the converted line"
            aria-label="Coordinate system for the converted line"
          >
            {COORD_SYSTEM_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {!!composerError && (
            <span className="text-xs px-2 py-1 rounded bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 border border-red-300 dark:border-red-700" role="alert">
              {composerError}
            </span>
          )}
        </div>

        {/* Controls (right) */}
        <div className="absolute right-2 bottom-2 flex items-center gap-3">
          {/* One capture control, adapted to the destination. In the Free-form
              note it accepts images and documents exactly as before. In the
              Template form it accepts only what the SELECTED row's field type
              can actually hold — a Photo row takes images, a File row takes
              documents, and a Text row or no selection can take neither, so the
              control is genuinely disabled and its tooltip says why. */}
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFilesSelected}
            style={{ display: "none" }}
            aria-label={captureLabel}
            // A picker HINT only. It is user-controlled and any file can be
            // dropped past it, so it decides nothing — validation happens
            // against the file itself (see editorImages / editorFileAttachments)
            // and the destination's field type is re-checked on arrival.
            accept={captureAccept}
          />
          <button
            type="button"
            title={canCaptureAnything ? captureLabel : captureReason || captureLabel}
            aria-label={captureLabel}
            onClick={() => fileInputRef.current?.click()}
            className="p-2 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-60"
            disabled={isDisabled || !canCaptureAnything}
          >
            <FaPlus />
          </button>

          <input
            type="file"
            accept="image/*"
            capture="environment"
            ref={cameraInputRef}
            onChange={handleCameraSelected}
            style={{ display: "none" }}
            aria-label="Take a photo with the camera"
          />
          <button
            type="button"
            title={
              canCaptureImage
                ? "Take photo"
                : captureReason || "Take photo"
            }
            aria-label="Take a photo with the camera"
            onClick={() => cameraInputRef.current?.click()}
            className="p-2 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-60"
            disabled={isDisabled || !canCaptureImage}
          >
            <FaCamera />
          </button>

          {/* Live transcript shortcut: opens the sidebar's Capture workspace
              (same session), red while that session is recording. It records
              nothing itself. */}
          <button
            type="button"
            onClick={handleVoiceClick}
            disabled={disabled}
            className={[
              "p-2 rounded-full border disabled:opacity-60",
              liveTranscriptRecording
                ? "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-200"
                : "bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200",
            ].join(" ")}
            aria-label={liveTranscriptRecording ? "Open Live transcript — recording" : "Open Live transcript"}
            title={liveTranscriptRecording ? "Live transcript — recording" : "Live transcript"}
            aria-haspopup="dialog"
          >
            <FaMicrophone aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={runRefine}
            disabled={!hasText || isDisabled}
            title="Refine with AI"
            className="p-2 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-60"
          >
            <FaStar />
          </button>

          {refinedDraft != null && (
            <button
              type="button"
              onClick={revertRefine}
              title="Revert"
              className="p-2 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200"
            >
              <FaUndo />
            </button>
          )}

          {/* NEW: trash to clear current draft (pre-send). It now clears the
              whole unsent composition — text, refine state and any staged
              attachments — and nothing that is already in the note. */}
          <button
            type="button"
            onClick={clearDraft}
            disabled={!hasComposition || isDisabled}
            title="Clear current message"
            className="w-9 h-9 flex items-center justify-center rounded-full bg-white dark:bg-[#1b1b1b] text-red-700 dark:text-red-200 border border-gray-300 dark:border-gray-600 disabled:opacity-60"
          >
            <FaTrash />
          </button>

          <button
            type="button"
            onClick={handleSend}
            // Enabled by text OR by at least one staged attachment: a photo on
            // its own is a complete capture and must not require a sentence.
            disabled={!canSubmit || isDisabled}
            title={
              canSend
                ? chipLabel
                  ? `Quick add to ${chipLabel}`
                  : "Quick add"
                : "Select a template row to Quick Add"
            }
            aria-label={
              canSend ? inputLabel.replace(/^Quick Add/, "Send Quick Add") : "Send Quick Add — select a template row first"
            }
            className="w-9 h-9 flex items-center justify-center rounded-full bg-white dark:bg-[#f0f0f0] text-gray-700 border border-gray-300 disabled:opacity-60"
          >
            <FaArrowUp />
          </button>
        </div>
      </div>
    </div>
  );
}
