// src/components/BottomBar.js
import React, { useRef, useState, useMemo, useEffect } from "react";
import { FaPlus, FaCamera, FaArrowUp, FaStar, FaUndo, FaTrash } from "react-icons/fa"; // NEW: FaTrash
import VoiceButton from "./VoiceButton";
import VoiceLanguageSelect from "./VoiceLanguageSelect";
import StylePresetSelect from "./StylePresetSelect";
import { useRefine } from "../hooks/useRefine";
import { useTranscription } from "../hooks/useTranscription";
import { useAppState } from "../context/AppStateContext";
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

const VOICE_LANG_MEM_KEY = "sitewise-note-voice-lang-v1";
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
  onInsertPDF,      // legacy
  onInsertPDFFile,  // preferred (bytes)
  disabled = false,
}) {
  const { currentNoteId } = useAppState();

  // Draft / refine state
  const [input, setInput] = useState("");
  const [refinedDraft, setRefinedDraft] = useState(null);
  const [originalBeforeRefine, setOriginalBeforeRefine] = useState(null);

  // Busy states
  const [busy, setBusy] = useState(false);
  const [transcribeStatus, setTranscribeStatus] = useState("idle");
  const [transcribeError, setTranscribeError] = useState("");

  // Voice language (per note memory)
  const [transcribeLang, setTranscribeLang] = useState("auto");

  // Style preset (per note memory)
  const [stylePreset, setStylePreset] = useState("concise, professional");

  // NEW: coordinate system state (default Mount Eden 2000)
  const [coordSystem, setCoordSystem] = useState(DEFAULT_COORD_SYSTEM);

  // Refs
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  // Hooks
  const { refineText } = useRefine();
  const { transcribeBlob } = useTranscription();

  // Derived
  const currentText = refinedDraft ?? input;
  const hasText = useMemo(() => currentText.trim().length > 0, [currentText]);
  const isDisabled = disabled || busy || transcribeStatus === "transcribing";

  const hasMediaDevices = useMemo(() => {
    return (
      typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function"
    );
  }, []);

  // Load per-note memory when note changes
  useEffect(() => {
    const langMap = loadMap(VOICE_LANG_MEM_KEY);
    const styleMap = loadMap(STYLE_MEM_KEY);
    const sysMap = loadMap(COORD_SYS_KEY);

    if (currentNoteId) {
      setTranscribeLang(langMap[currentNoteId] || "auto");
      setStylePreset(styleMap[currentNoteId] || "concise, professional");
      setCoordSystem(sysMap[currentNoteId] || DEFAULT_COORD_SYSTEM);
    } else {
      setTranscribeLang("auto");
      setStylePreset("concise, professional");
      setCoordSystem(DEFAULT_COORD_SYSTEM);
    }
  }, [currentNoteId]);

  // Persist language/style/system when changed
  useEffect(() => {
    if (!currentNoteId) return;
    const langMap = loadMap(VOICE_LANG_MEM_KEY);
    langMap[currentNoteId] = transcribeLang || "auto";
    saveMap(VOICE_LANG_MEM_KEY, langMap);
  }, [currentNoteId, transcribeLang]);

  useEffect(() => {
    if (!currentNoteId) return;
    const styleMap = loadMap(STYLE_MEM_KEY);
    styleMap[currentNoteId] = stylePreset || "concise, professional";
    saveMap(STYLE_MEM_KEY, styleMap);
  }, [currentNoteId, stylePreset]);

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

  async function buildStampedImageBLOB(file) {
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
      stampedCanvas.toBlob(resolve, "image/png", 0.92)
    );
    return stampedBlob;
  }
  // ----------------------------------------------------------

  const handleSend = () => {
    const text = (refinedDraft ?? input).trim();
    if (!text || !onInsertText || !editor) return;
    onInsertText(text);
    setInput("");
    setRefinedDraft(null);
    setOriginalBeforeRefine(null);
    setTranscribeError("");
  };

  // NEW: clear the current textarea draft (post-transcription, pre-send)
  const clearDraft = () => {
    setRefinedDraft(null);
    setInput("");
    setOriginalBeforeRefine(null);
    setTranscribeError("");
  };

  const handleFilesSelected = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        const stampedBlob = await buildStampedImageBLOB(f);
        const stampedURL = URL.createObjectURL(stampedBlob);
        editor?.chain().focus().insertContent(
          `<figure class="my-2"><img src="${stampedURL}" alt="photo" style="max-width:100%;height:auto;display:block;border-radius:10px;" /></figure>`
        ).run();
        continue;
      }
      if (f.type === "application/pdf") {
        const ab = await f.arrayBuffer();
        const bytes = new Uint8Array(ab);
        if (onInsertPDFFile) {
          await onInsertPDFFile({ fileName: f.name, bytes });
        } else if (onInsertPDF) {
          const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
          onInsertPDF(url);
        }
      } else {
        const url = URL.createObjectURL(f);
        editor?.chain().focus().insertContent(
          `<p><a href="${url}" target="_blank" rel="noopener noreferrer">${f.name}</a></p>`
        ).run();
        setTimeout(() => URL.revokeObjectURL(url), 15000);
      }
    }
    e.target.value = "";
  };

  const handleCameraSelected = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      const url = URL.createObjectURL(f);
      editor?.chain().focus().insertContent(
        `<p><a href="${url}" target="_blank" rel="noopener noreferrer">${f.name}</a></p>`
      ).run();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      e.target.value = "";
      return;
    }
    const stampedBlob = await buildStampedImageBLOB(f);
    const stampedURL = URL.createObjectURL(stampedBlob);
    editor?.chain().focus().insertContent(
      `<figure class="my-2"><img src="${stampedURL}" alt="photo" style="max-width:100%;height:auto;display:block;border-radius:10px;" /></figure>`
    ).run();
    e.target.value = "";
  };

  // ---------------- Recording (plus cancel) ----------------
  const pickMimeType = () => {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    for (const type of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(type)) return type;
    }
    return "";
  };
  const startRecording = async () => {
    if (!hasMediaDevices || disabled || transcribeStatus !== "idle") return;
    setTranscribeError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = null;
      mr.start();
      mediaRecorderRef.current = mr;
      setTranscribeStatus("recording");
    } catch (err) {
      setTranscribeError(err?.message || "Microphone permission denied");
      setTranscribeStatus("idle");
    }
  };
  const stopRecording = async () => {
    if (transcribeStatus !== "recording" || !mediaRecorderRef.current) return null;
    setTranscribeStatus("stopping");
    return new Promise((resolve) => {
      mediaRecorderRef.current.onstop = () => {
        const type = mediaRecorderRef.current.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        resolve(blob);
      };
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
    });
  };

  // NEW: cancel recording (trash while recording)
  const cancelRecording = () => {
    try {
      if (mediaRecorderRef.current) {
        try { mediaRecorderRef.current.onstop = null; } catch {}
        try { mediaRecorderRef.current.stop(); } catch {}
        try { mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop()); } catch {}
      }
    } finally {
      chunksRef.current = [];
      mediaRecorderRef.current = null;
      setTranscribeStatus("idle");
      setTranscribeError("");
    }
  };

  const handleVoiceClick = async () => {
    if (disabled || !editor || !hasMediaDevices) {
      if (!hasMediaDevices) setTranscribeError("Microphone not available in this browser.");
      return;
    }
    if (transcribeStatus === "idle") {
      await startRecording();
      return;
    }
    if (transcribeStatus === "recording") {
      const blob = await stopRecording();
      if (!blob) {
        setTranscribeStatus("idle");
        setTranscribeError("No audio captured");
        return;
      }
      const url = URL.createObjectURL(blob);
      editor.chain().focus().insertContent(
        `<p><audio controls src="${url}" preload="metadata"></audio></p>`
      ).run();
      setTranscribeStatus("transcribing");
      try {
        const text = await transcribeBlob(blob, transcribeLang);
        setTranscribeStatus("idle");
        if (text) {
          if (refinedDraft != null) setRefinedDraft((p) => (p ? `${p} ${text}` : text));
          else setInput((p) => (p ? `${p} ${text}` : text));
        } else {
          setTranscribeError("Empty transcription");
        }
      } catch (e) {
        setTranscribeStatus("idle");
        setTranscribeError(e?.message || "Transcription failed");
      }
      return;
    }
  };
  // ----------------------------------------------------------

  // AI refine (unchanged)
  const runRefine = async () => {
    const text = (refinedDraft ?? input).trim();
    if (!text) return;
    try {
      setBusy(true);
      setTranscribeError("");
      if (originalBeforeRefine == null) setOriginalBeforeRefine(input);
      const refined = await refineText({ text, style: stylePreset });
      setRefinedDraft(refined);
    } catch (e) {
      alert(e?.message || "Refine failed");
    } finally {
      setBusy(false);
    }
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
        <textarea
          className="w-full resize-none bg-transparent outline-none text-sm text-black dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
          placeholder={transcribeStatus === "transcribing" ? "Transcribing…" : "Type, dictate, or refine with AI…"}
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
          <VoiceLanguageSelect
            value={transcribeLang}
            onChange={setTranscribeLang}
            disabled={isDisabled}
          />
          <StylePresetSelect
            value={stylePreset}
            onChange={setStylePreset}
            disabled={isDisabled}
          />

          {/* NEW: converter dropdown (no label, no button) */}
          <select
            className="text-xs rounded border px-2 py-1 bg-white dark:bg-[#1b1b1b] text-black dark:text-white border-gray-300 dark:border-gray-600"
            value={coordSystem}
            onChange={(e) => setCoordSystem(e.target.value)}
            disabled={isDisabled}
            title="Choose coordinate system for the converted line"
          >
            {COORD_SYSTEM_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {transcribeStatus === "transcribing" && (
            <span className="text-xs px-2 py-1 rounded bg-yellow-100 text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-200 border border-yellow-300 dark:border-yellow-700">
              Transcribing…
            </span>
          )}
          {!!transcribeError && (
            <span className="text-xs px-2 py-1 rounded bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 border border-red-300 dark:border-red-700">
              {transcribeError}
            </span>
          )}
        </div>

        {/* Controls (right) */}
        <div className="absolute right-2 bottom-2 flex items-center gap-3">
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFilesSelected}
            style={{ display: "none" }}
            accept="image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          />
          <button
            type="button"
            title="Add files"
            onClick={() => fileInputRef.current?.click()}
            className="p-2 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-60"
            disabled={isDisabled}
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
          />
          <button
            type="button"
            title="Take photo"
            onClick={() => cameraInputRef.current?.click()}
            className="p-2 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-60"
            disabled={isDisabled}
          >
            <FaCamera />
          </button>

          {/* NEW: red trash to cancel current recording */}
          {transcribeStatus === "recording" && (
            <button
              type="button"
              onClick={cancelRecording}
              title="Discard recording"
              className="p-2 rounded-full bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-200"
            >
              <FaTrash />
            </button>
          )}

          <div className="p-0.5 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200" title="Record voice">
            <VoiceButton
              phase={transcribeStatus}
              disabled={disabled || !hasMediaDevices}
              onClick={handleVoiceClick}
            />
          </div>

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

          {/* NEW: trash to clear current draft (pre-send) */}
          <button
            type="button"
            onClick={clearDraft}
            disabled={!hasText || isDisabled}
            title="Clear current message"
            className="w-9 h-9 flex items-center justify-center rounded-full bg-white dark:bg-[#1b1b1b] text-red-700 dark:text-red-200 border border-gray-300 dark:border-gray-600 disabled:opacity-60"
          >
            <FaTrash />
          </button>

          <button
            type="button"
            onClick={handleSend}
            disabled={!hasText || isDisabled}
            title="Send"
            className="w-9 h-9 flex items-center justify-center rounded-full bg-white dark:bg-[#f0f0f0] text-gray-700 border border-gray-300 disabled:opacity-60"
          >
            <FaArrowUp />
          </button>
        </div>
      </div>
    </div>
  );
}
