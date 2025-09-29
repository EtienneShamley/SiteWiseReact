// src/hooks/useTranscription.js
const API_BASE = process.env.REACT_APP_API_BASE || "";

export function useTranscription() {
  async function transcribeBlob(blob) {
    const form = new FormData();
    form.append("audio", blob, "audio.webm");

    const resp = await fetch(`${API_BASE}/api/transcribe`, {
      method: "POST",
      body: form,
    });

    const data = await resp
      .json()
      .catch(async () => ({ error: await resp.text() }));

    if (!resp.ok) {
      throw new Error(data?.error || "Transcription request failed");
    }
    return data?.text || "";
  }

  return { transcribeBlob };
}
