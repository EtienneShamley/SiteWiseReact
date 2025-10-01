// src/hooks/useTranscription.js
const API_BASE = process.env.REACT_APP_API_BASE || "";

// Fetch with a hard timeout
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 60000, ...rest } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(resource, { ...rest, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

export function useTranscription() {
  const transcribeBlob = async (blob) => {
    const form = new FormData();
    form.append("audio", blob, "audio.webm");

    let resp;
    try {
      resp = await fetchWithTimeout(`${API_BASE}/api/transcribe`, {
        method: "POST",
        body: form,
        timeout: 60000,
      });
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Request timed out" : "Network error";
      throw new Error(msg);
    }

    // Try JSON first, then fall back to raw text
    let data;
    try {
      data = await resp.json();
    } catch {
      const txt = await resp.text();
      data = { error: txt };
    }

    if (!resp.ok) {
      throw new Error(data?.error || "Transcription failed");
    }

    return data.text || "";
  };

  return { transcribeBlob };
}
