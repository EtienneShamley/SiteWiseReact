// src/hooks/useRefine.js
const API_BASE = process.env.REACT_APP_API_BASE || "";

// Calls POST /api/refine and returns the refined string.
// Falls back to the original text if the endpoint is missing or errors.
export function useRefine() {
  const refineText = async ({ text, language = "English", style = "concise, professional" }) => {
    if (!text || !text.trim()) return text;

    try {
      const resp = await fetch(`${API_BASE}/api/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, language, style }),
      });

      // If the backend route isn’t there, keep user text
      if (resp.status === 404) return text;

      const data = await resp.json().catch(async () => ({ error: await resp.text() }));
      if (!resp.ok) throw new Error(data?.error || "Refine request failed");

      // Server returns { refined }
      return (data?.refined || "").trim() || text;
    } catch {
      // Graceful fallback
      return text;
    }
  };

  return { refineText };
}
