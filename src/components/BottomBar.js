// src/components/BottomBar.js
import React, { useRef, useState, useMemo } from "react";
import { FaPlus, FaCamera, FaArrowUp, FaStar, FaUndo } from "react-icons/fa";
import VoiceButton from "./VoiceButton";
import { useRefine } from "../hooks/useRefine";
import { useTranscription } from "../hooks/useTranscription";
import exifr from "exifr";

const GOOGLE_STATIC_KEY = process.env.REACT_APP_GOOGLE_MAPS_KEY || "";

export default function BottomBar({
  editor,
  onInsertText,
  onInsertPDF,
  disabled = false,
}) {
  // Draft / refine state
  const [input, setInput] = useState("");
  const [refinedDraft, setRefinedDraft] = useState(null);
  const [originalBeforeRefine, setOriginalBeforeRefine] = useState(null);

  // Busy states
  const [busy, setBusy] = useState(false);
  const [transcribeStatus, setTranscribeStatus] = useState("idle"); // idle|recording|stopping|transcribing
  const [transcribeError, setTranscribeError] = useState("");

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

  // ---------------- EXIF / GPS stamp helpers ----------------
  function nextStampIndex() {
    try {
      const k = "sitewise_photo_index";
      const cur = parseInt(localStorage.getItem(k) || "0", 10) || 0;
      const nxt = cur + 1;
      localStorage.setItem(k, String(nxt));
      return nxt;
    } catch {
      return Math.floor(Math.random() * 10000);
    }
  }

  async function getExifGeoAndTime(file) {
    try {
      const gps = await exifr.gps(file).catch(() => null);
      const tags = await exifr
        .parse(file, ["DateTimeOriginal"])
        .catch(() => null);
      const lat = gps?.latitude ?? null;
      const lon = gps?.longitude ?? null;
      const exifDate =
        tags?.DateTimeOriginal instanceof Date ? tags.DateTimeOriginal : null;
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
      const opts = {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 0,
      };
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy, altitude, speed } =
            pos.coords || {};
          if (typeof latitude === "number" && typeof longitude === "number") {
            resolve({
              lat: latitude,
              lon: longitude,
              acc: accuracy ?? null,
              alt: typeof altitude === "number" ? altitude : null, // meters
              spd: typeof speed === "number" ? speed : null, // m/s
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

      // Build a friendly multi-line address
      const line1 =
        [a.house_number, a.road].filter(Boolean).join(" ").trim() || null;
      const line2 = a.suburb || a.neighbourhood || a.locality || null;
      // Prefer city/town/village over county
      const line3 = a.city || a.town || a.village || a.county || null;
      const line4 = a.state || a.region || a.province || null;

      return [line1, line2, line3, line4].filter(Boolean);
    } catch {
      return null;
    }
  }

  function staticMapURL(lat, lon) {
    if (!lat || !lon) return "";
    if (GOOGLE_STATIC_KEY) {
      const size = "220x220";
      const zoom = 16;
      const marker = `color:red%7C${lat},${lon}`;
      return `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=${zoom}&size=${size}&maptype=roadmap&markers=${marker}&key=${GOOGLE_STATIC_KEY}`;
    }
    // No key: return empty. UI will show a fallback link instead.
    return "";
  }

  async function buildStampedImageHTML(file, objectUrl) {
    const {
      lat: exifLat,
      lon: exifLon,
      exifDate,
      altitude: exifAlt,
    } = await getExifGeoAndTime(file);

    let lat = exifLat;
    let lon = exifLon;
    let acc = null;
    let alt = exifAlt; // m
    let spdMs = null; // m/s

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

    const indexNo = nextStampIndex();

    // Times: EXIF date as “network”-like; device now as local
    const networkDt = exifDate || new Date();
    const localDt = new Date();

    const networkStr = formatLocalWithTz(networkDt);
    const localStr = formatLocalWithTz(localDt);

    // Address (best-effort)
    let addrLines = null;
    if (lat != null && lon != null) {
      addrLines = await reverseGeocode(lat, lon);
    }

    // If no address, we’ll fall back to showing coordinates
    const coordStr =
      lat != null && lon != null
        ? `${lat.toFixed(6)}, ${lon.toFixed(6)}`
        : null;

    const altStr = typeof alt === "number" ? `${alt.toFixed(1)}m` : "0.0m";
    const spdStr =
      typeof spdMs === "number" ? `${(spdMs * 3.6).toFixed(1)}km/h` : "0.0km/h";

    const lines = [`network: ${networkStr}`, `Local: ${localStr}`];

    // Prefer human-readable address; otherwise show coords
    if (addrLines && addrLines.length) {
      lines.push(...addrLines);
    } else if (coordStr) {
      lines.push(coordStr);
    }

    lines.push(`Altitude: ${altStr}`);
    lines.push(`speed: ${spdStr}`);
    lines.push(`index number ${indexNo}`);

    // Right-corner map image or fallback link
    const mapUrl = lat && lon ? staticMapURL(lat, lon) : "";
    const mapsLink =
      lat && lon ? `https://www.google.com/maps?q=${lat},${lon}` : "#";

    const leftBoxHTML = `
      <div
        class="absolute left-2 top-2"
        style="
          font-size:12px;
          line-height:1.2;
          background: rgba(0,0,0,0.55);
          color: #fff;
          padding: 6px 8px;
          border-radius: 6px;
          max-width: 60%;
          white-space: pre-line;
        "
      >${lines.join("\n")}</div>
    `;

    const rightBoxHTML = mapUrl
      ? `
        <img
          src="${mapUrl}"
          alt="map"
          class="absolute right-2 top-2"
          style="
            width: 110px;
            height: 110px;
            object-fit: cover;
            border-radius: 8px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.25);
            background: #eee;
          "
        />
      `
      : lat && lon
      ? `
          <a
            href="${mapsLink}"
            target="_blank" rel="noopener noreferrer"
            class="absolute right-2 top-2"
            style="
              font-size:12px;
              background:#fff;
              color:#111;
              padding:6px 8px;
              border-radius:8px;
              text-decoration:underline;
            "
          >Open in Google Maps</a>
        `
      : "";

    return `
      <figure class="relative inline-block my-2">
        <img src="${objectUrl}" alt="photo" style="max-width:100%;height:auto;display:block;border-radius:10px;" />
        ${leftBoxHTML}
        ${rightBoxHTML}
      </figure>
    `;
  }
  // ----------------------------------------------------------

  // Send text into the editor
  const handleSend = () => {
    const text = currentText.trim();
    if (!text || !onInsertText || !editor) return;
    onInsertText(text);
    setInput("");
    setRefinedDraft(null);
    setOriginalBeforeRefine(null);
    setTranscribeError("");
  };

  // File handlers
  const handleFilesSelected = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        const url = URL.createObjectURL(f);
        const stamped = await buildStampedImageHTML(f, url);
        editor?.chain().focus().insertContent(stamped).run();
        // do not revoke immediately; allow loading
        continue;
      }
      if (f.type === "application/pdf") {
        const url = URL.createObjectURL(f);
        onInsertPDF && onInsertPDF(url);
        setTimeout(() => URL.revokeObjectURL(url), 15000);
      } else {
        const url = URL.createObjectURL(f);
        editor
          ?.chain()
          .focus()
          .insertContent(
            `<p><a href="${url}" target="_blank" rel="noopener noreferrer">${f.name}</a></p>`
          )
          .run();
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
      editor
        ?.chain()
        .focus()
        .insertContent(
          `<p><a href="${url}" target="_blank" rel="noopener noreferrer">${f.name}</a></p>`
        )
        .run();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      e.target.value = "";
      return;
    }
    const url = URL.createObjectURL(f);
    const stamped = await buildStampedImageHTML(f, url);
    editor?.chain().focus().insertContent(stamped).run();
    e.target.value = "";
  };

  // ---------------- Recording owned by parent ----------------
  const pickMimeType = () => {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4", // Safari sometimes uses this
    ];
    for (const type of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(type))
        return type;
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
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
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
    if (transcribeStatus !== "recording" || !mediaRecorderRef.current)
      return null;
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

  const handleVoiceClick = async () => {
    if (disabled || !editor || !hasMediaDevices) {
      if (!hasMediaDevices)
        setTranscribeError("Microphone not available in this browser.");
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
      // Preview audio in editor
      const url = URL.createObjectURL(blob);
      editor
        .chain()
        .focus()
        .insertContent(
          `<p><audio controls src="${url}" preload="metadata"></audio></p>`
        )
        .run();

      // Transcribe
      setTranscribeStatus("transcribing");
      try {
        const text = await transcribeBlob(blob);
        setTranscribeStatus("idle");
        if (text) {
          if (refinedDraft != null)
            setRefinedDraft((p) => (p ? `${p} ${text}` : text));
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

  // AI refine
  const runRefine = async () => {
    const text = currentText.trim();
    if (!text) return;
    try {
      setBusy(true);
      setTranscribeError("");
      if (originalBeforeRefine == null) setOriginalBeforeRefine(input);
      const refined = await refineText({ text });
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
          placeholder={
            transcribeStatus === "transcribing"
              ? "Transcribing…"
              : "Type, dictate, or refine with AI…"
          }
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
        />

        {/* Status row */}
        <div className="absolute left-3 bottom-2 flex items-center gap-3">
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

        {/* Controls */}
        <div className="absolute right-2 bottom-2 flex items-center gap-2">
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

          <div className="p-0.5 rounded-full bg-white dark:bg-[#1b1b1b] border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200">
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
