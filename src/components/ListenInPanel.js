// src/components/ListenInPanel.js
import React, { useMemo } from "react";
import VoiceButton from "./VoiceButton";
import VoiceLanguageSelect from "./VoiceLanguageSelect";
import useListenIn from "../hooks/useListenIn";

/**
 * ListenInPanel
 *
 * Props:
 * - onInsert: (textOrHtml: string) => void
 */
export default function ListenInPanel({ onInsert, defaultLanguage = "auto" }) {
  const {
    phase,
    isRecording,
    language,
    setLanguage,
    rawTranscript,
    summaryText,
    error,
    startSession,
    stopAndProcess,
    reset,
    buildInsertPayload,
  } = useListenIn(defaultLanguage);

  const disabled =
    phase === "stopping" || phase === "transcribing" || phase === "summarising";

  const phaseLabel = useMemo(() => {
    switch (phase) {
      case "recording":
        return "Recording…";
      case "stopping":
        return "Stopping…";
      case "transcribing":
        return "Transcribing…";
      case "summarising":
        return "Summarising…";
      case "error":
        return "Error";
      default:
        return "";
    }
  }, [phase]);

  const handleMicClick = async () => {
    if (phase === "idle") {
      await startSession();
    } else if (phase === "recording") {
      await stopAndProcess();
    }
  };

  // Turn plain-text payload into HTML with bigger, bold headings
  const handleInsert = () => {
    if (!onInsert) return;
    const payload = buildInsertPayload();
    if (!payload) return;

    const base = String(payload || "").trim();
    if (!base) return;

    // Helper: escape basic HTML entities to avoid breaking HTML
    const escapeHtml = (str) =>
      str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Helper: convert plain text into <p>...</p> blocks with <br/> for single newlines
    const toParagraphHtml = (txt) =>
      txt
        .split(/\n{2,}/) // split on blank lines into paragraphs
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
        .join("");

    // Try to split out an "Action items:" section if present
    const parts = base.split(/Action items:/i);
    const summaryPart = parts[0]?.trim() || "";
    const actionPart = parts.length > 1 ? parts.slice(1).join("Action items:").trim() : "";

    let html = "";

    if (summaryPart) {
      html += `<h3><strong>Summary</strong></h3>`;
      html += toParagraphHtml(summaryPart);
    }

    if (actionPart) {
      html += `<h4><strong>Action items</strong></h4>`;
      html += toParagraphHtml(actionPart);
    }

    // Fallback: if somehow both empty, bail
    if (!html.trim()) return;

    onInsert(html);
  };

  return (
    <div className="border rounded-lg bg-white dark:bg-[#1b1b1b] border-gray-300 dark:border-gray-700 p-2 text-xs flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium opacity-80">Listen-In (meeting capture)</div>
        <div className="flex items-center gap-2">
          <VoiceLanguageSelect
            value={language}
            onChange={setLanguage}
            disabled={disabled || phase === "recording"}
          />
          <VoiceButton
            phase={
              phase === "recording"
                ? "recording"
                : disabled
                ? "transcribing"
                : "idle"
            }
            disabled={false}
            onClick={handleMicClick}
          />
        </div>
      </div>

      {phaseLabel && (
        <div className="text-[11px] opacity-80">
          {phaseLabel}
          {isRecording ? " — mic on" : ""}
        </div>
      )}

      {error && (
        <div className="text-[11px] text-red-600">
          {error.message || String(error)}
        </div>
      )}

      {(summaryText || rawTranscript) && (
        <div className="mt-1 flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wide opacity-70">
              Preview
            </div>
            <div className="flex gap-1">
              <button
                className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-[11px]"
                onClick={handleInsert}
              >
                Insert into note
              </button>
              <button
                className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-[11px]"
                onClick={reset}
              >
                Clear
              </button>
            </div>
          </div>
          <div className="border border-gray-200 dark:border-gray-700 rounded bg-gray-50 dark:bg-[#101010] p-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">
            {summaryText || rawTranscript}
          </div>
        </div>
      )}
    </div>
  );
}
