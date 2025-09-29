// src/hooks/useRefinement.js
const API_BASE = process.env.REACT_APP_API_BASE || "";

export function useRefinement() {
  const refineText = async (text, mode = "professional") => {
    const resp = await fetch(`${API_BASE}/api/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode }),
    });
    const data = await resp.json().catch(async () => ({ error: await resp.text() }));
    if (!resp.ok) {
      throw new Error(data?.error || "Refinement request failed");
    }
    return data.refined || "";
  };

  return { refineText };
}
