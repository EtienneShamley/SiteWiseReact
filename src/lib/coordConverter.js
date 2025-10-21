// src/lib/coordConverter.js
// Offline-first coordinate conversion & formatting.
// Uses proj4 (dynamically imported) with embedded EPSG defs for:
//  - NZTM (EPSG:2193)
//  - Mount Eden Circuit 2000 (EPSG:2105)
// Falls back to WGS84 display if something goes wrong.
// No API keys required.

let proj4Promise = null;

function ensureProj4() {
  if (!proj4Promise) {
    proj4Promise = import("proj4").then((m) => {
      const proj4 = m.default || m;

      // EPSG:2193 — NZGD2000 / New Zealand Transverse Mercator 2000
      // Source: https://epsg.io/2193.proj4
      // +proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +units=m +no_defs +type=crs
      proj4.defs(
        "EPSG:2193",
        "+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +units=m +no_defs +type=crs"
      );

      // EPSG:2105 — NZGD2000 / Mount Eden 2000
      // Source: https://epsg.io/2105.proj4js
      // +proj=tmerc +lat_0=-36.8797222222222 +lon_0=174.764166666667 +k=0.9999 +x_0=400000 +y_0=800000 +ellps=GRS80 +units=m +no_defs +type=crs
      proj4.defs(
        "EPSG:2105",
        "+proj=tmerc +lat_0=-36.8797222222222 +lon_0=174.764166666667 +k=0.9999 +x_0=400000 +y_0=800000 +ellps=GRS80 +units=m +no_defs +type=crs"
      );

      // WGS84
      proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

      return proj4;
    });
  }
  return proj4Promise;
}

// UI options
export const COORD_SYSTEM_OPTIONS = [
  { value: "MOUNT_EDEN_2000", label: "Mount Eden Circuit 2000" },
  { value: "NZTM",            label: "NZTM (New Zealand Transverse Mercator)" },
  { value: "WGS84",           label: "WGS84" },
];

// Default selection
export const DEFAULT_COORD_SYSTEM = "MOUNT_EDEN_2000";

/**
 * Format the “converted” result line that appears under the Coordinates line.
 * Works offline via proj4. Returns a single-line string (or null if no lat/lon).
 *
 * @param {"MOUNT_EDEN_2000"|"NZTM"|"WGS84"} coordSystem
 * @param {number|null} lat  latitude in degrees (WGS84)
 * @param {number|null} lon  longitude in degrees (WGS84)
 * @returns {Promise<string|null>}
 */
export async function formatConvertedLineAsync(coordSystem, lat, lon) {
  if (lat == null || lon == null) return null;

  if (coordSystem === "WGS84") {
    // Just echo WGS84 lat/lon (already printed on the Coordinates line)
    return `WGS84: ${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  }

  try {
    const proj4 = await ensureProj4();

    if (coordSystem === "NZTM") {
      // Transform WGS84 (lon,lat) -> EPSG:2193 meters
      const [E, N] = proj4("EPSG:4326", "EPSG:2193", [lon, lat]);
      return `NZTM (EPSG:2193): E ${Math.round(E)}, N ${Math.round(N)}`;
    }

    if (coordSystem === "MOUNT_EDEN_2000") {
      // Transform WGS84 (lon,lat) -> EPSG:2105 meters
      const [E, N] = proj4("EPSG:4326", "EPSG:2105", [lon, lat]);
      return `Mount Eden 2000 (EPSG:2105): E ${Math.round(E)}, N ${Math.round(N)}`;
    }
  } catch {
    // ignore and fall back
  }

  // Fallback to showing WGS84 line if anything fails
  return `WGS84: ${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}
