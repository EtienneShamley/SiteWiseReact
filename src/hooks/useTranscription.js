export function useTranscription() {
  async function transcribeBlob(blob) {
    const form = new FormData();
    form.append("audio", blob, "audio.webm");

    const resp = await fetch("/api/transcribe", {
      method: "POST",
      body: form
    });

    if (!resp.ok) {
      throw new Error("Transcription request failed");
    }
    const data = await resp.json();
    return data.text || "";
  }

  return { transcribeBlob };
}
