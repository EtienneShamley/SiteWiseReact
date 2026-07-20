// src/lib/id.js
//
// Stable id generation. Prefers crypto.randomUUID() (collision-resistant,
// stable across reloads/renames/linking) with a safe fallback for the rare
// environment where it is unavailable (older browsers, insecure contexts).

export function newId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the manual fallback
  }
  // RFC-4122-ish v4 fallback using getRandomValues when available.
  try {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
      return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
    }
  } catch {
    // fall through
  }
  // Last-resort fallback (non-crypto). Still unique enough for local ids.
  return `id-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
