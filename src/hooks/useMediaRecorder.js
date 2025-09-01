import { useEffect, useRef, useState } from "react";

// Choose a supported audio mimeType at runtime (varies by browser)
function pickSupportedMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4", // Safari may only expose this, but recording support is flaky
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  // As last resort, let the browser pick default by omitting mimeType
  return "";
}

export default function useMediaRecorder() {
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);

  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState(null);
  const [mimeType, setMimeType] = useState("");

  useEffect(() => {
    setMimeType(pickSupportedMime());
  }, []);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const opts = {};
      if (mimeType) opts.mimeType = mimeType;

      const mr = new MediaRecorder(stream, opts);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onerror = (e) => setError(e.error || e);

      mr.start();
      setIsRecording(true);
    } catch (e) {
      setError(e);
      setIsRecording(false);
    }
  };

  const stop = () => {
    const mr = mediaRecorderRef.current;
    if (!mr) return Promise.resolve(null);

    return new Promise((resolve) => {
      mr.onstop = () => {
        const chosenType = mimeType || (mr.mimeType || "audio/webm");
        const blob = new Blob(chunksRef.current, { type: chosenType });
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop());
          streamRef.current = null;
        }
        resolve(blob);
      };
      try {
        mr.stop();
      } catch (e) {
        setError(e);
        resolve(null);
      }
      setIsRecording(false);
    });
  };

  return { isRecording, start, stop, error, mimeType: mimeType || "audio/webm" };
}
