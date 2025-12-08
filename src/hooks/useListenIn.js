// src/hooks/useListenIn.js
import { useCallback, useState } from "react";
import useMediaRecorder from "./useMediaRecorder";
import { useTranscription } from "./useTranscription";
import { useRefine } from "./useRefine";

/**
 * useListenIn
 *
 * Phases:
 *   idle | recording | stopping | transcribing | summarising | error
 */
export default function useListenIn(initialLanguage = "auto") {
  const [phase, setPhase] = useState("idle");
  const [language, setLanguage] = useState(initialLanguage);
  const [rawTranscript, setRawTranscript] = useState("");
  const [summaryText, setSummaryText] = useState("");
  const [error, setError] = useState(null);

  const { isRecording, start, stop, error: mediaError } = useMediaRecorder();
  const { transcribeBlob } = useTranscription();
  const { refineText } = useRefine();

  const effectiveRecording = phase === "recording" && isRecording;

  const reset = useCallback(() => {
    setRawTranscript("");
    setSummaryText("");
    setError(null);
    setPhase("idle");
  }, []);

  const startSession = useCallback(async () => {
    if (phase !== "idle") return;
    setError(null);
    setRawTranscript("");
    setSummaryText("");
    try {
      setPhase("recording");
      await start();
    } catch (e) {
      console.error("[listen-in] start error:", e);
      setError(e);
      setPhase("error");
    }
  }, [phase, start]);

  const stopAndProcess = useCallback(async () => {
    if (phase !== "recording") return;
    setPhase("stopping");
    setError(null);

    try {
      const blob = await stop();
      if (!blob || blob.size === 0) {
        throw new Error("No audio captured");
      }

      // 1) Transcribe
      setPhase("transcribing");
      const transcript = await transcribeBlob(blob, language || "auto");
      setRawTranscript(transcript || "");

      // 2) Summarise into meeting notes + actions
      setPhase("summarising");
      const style =
        "meeting notes; summarise key points clearly with headings, and end with a separate 'Action items' list with bullets.";
      const refined = await refineText({
        text: transcript,
        language: "English",
        style,
      });
      setSummaryText(refined || transcript || "");
      setPhase("idle");
    } catch (e) {
      console.error("[listen-in] stop/process error:", e);
      setError(e instanceof Error ? e : new Error("Listen-in failed"));
      setPhase("error");
    }
  }, [phase, stop, transcribeBlob, refineText, language]);

  const buildInsertPayload = useCallback(() => {
    if (!summaryText && !rawTranscript) return "";
    const header = "Meeting summary\n\n";
    const rawBlock = rawTranscript
      ? "\n\n---\nRaw transcript (for reference):\n\n" + rawTranscript.trim()
      : "";
    return header + (summaryText || "").trim() + rawBlock;
  }, [summaryText, rawTranscript]);

  return {
    phase,
    isRecording: effectiveRecording,
    language,
    setLanguage,
    rawTranscript,
    summaryText,
    error: error || mediaError || null,
    startSession,
    stopAndProcess,
    reset,
    buildInsertPayload,
  };
}
