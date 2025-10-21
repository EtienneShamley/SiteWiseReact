// src/lib/linzConverter.js
// Thin client for LINZ coordinate conversion API.
// Docs: https://www.geodesy.linz.govt.nz/api/conversions/v1

const BASE = "https://www.geodesy.linz.govt.nz/api/conversions/v1";
const CRS_CACHE_KEY = "linz_crs_cache_v1";
const CRS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function nowMs() { return Date.now(); }

function loadCrsCache() {
  try {
    const raw = localStorage.getItem(CRS_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    if (!obj.expires || obj.expires < nowMs()) return null;
    return obj.data || null;
  } catch {
    return null;
  }
}
function saveCrsCache(data) {
  try {
    localStorage.setItem(
      CRS_CACHE_KEY,
      JSON.stringify({ expires: nowMs() + CRS_CACHE_TTL_MS, data })
    );
  } catch {}
}

/**
 * Fetch and cache the LINZ CRS list, return an object { crs: [...], verticalCrs: [...] }.
 */
async function fetchLinzCrsList() {
  const cached = loadCrsCache();
  if (cached) return cached;

  const url = `${BASE}/list-coordinate-systems`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`LINZ list-coordinate-systems error: ${res.status}`);
  }
  const data = await res.json();
  if (!data || data.status !== "success") {
    throw new Error("LINZ list-coordinate-systems returned non-success status");
  }
  saveCrsCache(data);
  return data;
}

/**
 * Attempt to find a LINZ CRS code by fuzzy matching a name.
 * Returns the linzCrsCode string (e.g., "NZTM") or null if not found.
 */
export async function getLinzCrsCodeByName(nameSubstr) {
  try {
    const list = await fetchLinzCrsList();
    const items = list?.crs || [];
    const needle = String(nameSubstr).toLowerCase();
    // prefer exact-ish match, else contains
    let best = null;
    for (const it of items) {
      const label = `${it.name || ""}`.toLowerCase();
      if (label === needle || label.includes(needle)) {
        best = it.linzCrsCode;
        break;
      }
    }
    // Special helpers: try to match words "Mount", "Eden", "Circuit", "2000"
    if (!best && /mount\s+eden/i.test(nameSubstr)) {
      for (const it of items) {
        const label = `${it.name || ""}`.toLowerCase();
        if (label.includes("mount") && label.includes("eden") && label.includes("circuit") && label.includes("2000")) {
          best = it.linzCrsCode;
          break;
        }
      }
    }
    return best || null;
  } catch {
    return null;
  }
}

/**
 * Convert a single WGS84/NZGD2000 lat/lon to NZTM via LINZ API.
 * Returns { E, N } in metres.
 */
export async function wgs84ToNZTM_API(latDeg, lonDeg, opts = {}) {
  const { coordinateEpoch = undefined, signal } = opts;

  const input = {
    crs: "LINZ:NZGD2000",
    coordinateOrder: ["north", "east"], // lat, lon
    ...(coordinateEpoch ? { coordinateEpoch } : {}),
    coordinates: [[latDeg, lonDeg]],
  };

  const params = new URLSearchParams();
  params.set("crs", "LINZ:NZTM"); // target
  params.set("coordinateOrder", "east/north");

  const url = `${BASE}/convert-to?${params.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });

  if (!res.ok) {
    let text;
    try { text = await res.text(); } catch { text = String(res.status); }
    throw new Error(`LINZ convert API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (data?.status !== "success") {
    throw new Error("LINZ convert API returned non-success status");
  }

  const coords = data?.coordinateList?.coordinates ?? [];
  if (!coords.length || !Array.isArray(coords[0])) {
    throw new Error("LINZ convert API returned empty coordinates");
  }

  const [E, N] = coords[0]; // because we requested east/north
  if (E == null || N == null) {
    throw new Error("LINZ convert API null result for coordinate");
  }

  return { E: Number(E), N: Number(N) };
}

/**
 * Convert a single WGS84/NZGD2000 lat/lon to a named local circuit via LINZ API.
 * Example name: "Mount Eden Circuit 2000"
 * Returns { E, N } in metres, or throws on error.
 */
export async function wgs84ToNamedCircuit_API(latDeg, lonDeg, circuitName, opts = {}) {
  const { coordinateEpoch = undefined, signal } = opts;

  const code = await getLinzCrsCodeByName(circuitName);
  if (!code) throw new Error(`LINZ CRS not found for "${circuitName}"`);

  const input = {
    crs: "LINZ:NZGD2000",
    coordinateOrder: ["north", "east"], // lat, lon
    ...(coordinateEpoch ? { coordinateEpoch } : {}),
    coordinates: [[latDeg, lonDeg]],
  };

  const params = new URLSearchParams();
  params.set("crs", `LINZ:${code}`); // target circuit
  params.set("coordinateOrder", "east/north");

  const url = `${BASE}/convert-to?${params.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });

  if (!res.ok) {
    let text;
    try { text = await res.text(); } catch { text = String(res.status); }
    throw new Error(`LINZ convert API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (data?.status !== "success") {
    throw new Error("LINZ convert API returned non-success status");
  }

  const coords = data?.coordinateList?.coordinates ?? [];
  const [E, N] = (coords && coords[0]) || [];
  if (E == null || N == null) {
    throw new Error("LINZ convert API null result for circuit coordinate");
  }

  return { E: Number(E), N: Number(N) };
}
