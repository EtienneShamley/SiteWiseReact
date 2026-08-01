// src/hooks/useRefine.js
//
// Thin React wrapper over src/lib/refineClient.js.
//
// BREAKING (deliberate, all callers updated in the same change): refineText no
// longer resolves with the caller's own text when the request fails. It now
// resolves with a structured outcome:
//
//   { ok: true,  refined }
//   { ok: false, outcome: "unavailable" | "failure", message }
//
// The previous fallback made a provider failure look identical to a successful
// refinement, which let callers flatten a formatted note and report success.
// Every caller must branch on `ok`; none may present its own input as an AI
// result.
import { useCallback } from "react";
import { requestRefine } from "../lib/refineClient";

export function useRefine() {
  const refineText = useCallback((options) => requestRefine(options), []);
  return { refineText };
}
