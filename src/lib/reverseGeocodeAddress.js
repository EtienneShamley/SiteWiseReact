// src/lib/reverseGeocodeAddress.js
//
// The address lines burnt into a Quick Add camera stamp, composed from what the
// reverse geocoder (Nominatim, `format=jsonv2`, `addressdetails=1`) actually
// returns for the coordinates the stamp is using. Pure: no network, no DOM.
// The capture bar fetches ONE answer; this composes it.
//
// ONE HONEST ANSWER. Nominatim's reverse lookup returns the single closest
// object it knows for the exact coordinate. On a beachfront that is the
// promenade — "Gold Coast Oceanway", a shared path it labels `road` — and that
// IS what the coordinate resolves to. It is composed as it is; no second
// lookup is made to pull the point onto a nearby street, because a street the
// photograph was not taken on is a fabrication, however postal it looks. The
// reverse-geocoded address is best-effort with the current provider; the
// coordinates on the same stamp are the authoritative record. When NoteWise
// later enables the planned Google Maps / geocoding services, richer ranked
// address results can be evaluated — not in Phase 7.8, and not with a paid
// geocoder.
//
// NOTHING IS INVENTED. Every line is a value the provider returned; a missing
// level is simply omitted, and equivalent values repeated across the hierarchy
// (suburb, city and county all "Gold Coast") appear once.

export const NOMINATIM_REVERSE_ENDPOINT = "https://nominatim.openstreetmap.org/reverse";

// Older Nominatim releases labelled a path or square by its own type instead
// of `road`; read as the feature line, exactly as `road` would be.
const WAY_ADDRESS_KEYS = Object.freeze(["road", "pedestrian", "footway", "cycleway", "path", "steps", "track"]);

const LOCALITY_KEYS = Object.freeze(["suburb", "neighbourhood", "quarter", "locality", "hamlet"]);
const CITY_KEYS = Object.freeze(["city", "town", "village", "municipality", "county"]);
const STATE_KEYS = Object.freeze(["state", "region", "province"]);

function text(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function lower(value) {
  const t = text(value);
  return t ? t.toLowerCase() : null;
}

function addressOf(response) {
  const a = response && typeof response === "object" ? response.address : null;
  return a && typeof a === "object" ? a : {};
}

function firstText(address, keys) {
  for (const key of keys) {
    const value = text(address[key]);
    if (value) return value;
  }
  return null;
}

/** The URL of the one reverse lookup for a coordinate. */
export function nominatimReverseUrl(lat, lon) {
  const params = new URLSearchParams({
    format: "jsonv2",
    lat: String(lat),
    lon: String(lon),
    addressdetails: "1",
  });
  return `${NOMINATIM_REVERSE_ENDPOINT}?${params.toString()}`;
}

/**
 * The way the coordinate resolves to — a street, or genuinely a path, a
 * promenade, a square — as the provider labelled it. Null when there is none.
 */
export function reverseGeocodeWay(response) {
  if (!response || typeof response !== "object") return null;
  return firstText(addressOf(response), WAY_ADDRESS_KEYS);
}

/**
 * The most specific named FEATURE the answer describes — the park, beach or
 * building the point is on — for the first line when no way is named.
 */
export function reverseGeocodeFeature(response) {
  if (!response || typeof response !== "object") return null;
  const a = addressOf(response);
  const named = text(response.name);
  if (named) return named;
  const type = lower(response.type);
  const category = lower(response.category) || lower(response.class);
  return (type && text(a[type])) || (category && text(a[category])) || null;
}

/**
 * Compose the stamp's address lines from the one answer.
 *
 *   house number + way     the street, or the path/promenade the point is on
 *   feature                only when no way is named
 *   suburb / neighbourhood
 *   city / town            ONLY when no suburb/locality was returned — a
 *                          suburb already places the point, and the broader
 *                          city line is noise beneath it
 *   state postcode         on one line, as a postal address is written
 *
 * Repeated values are shown once. Nothing is fabricated; an empty answer is
 * `null`, exactly as a failed lookup is.
 *
 * @param {object|null} response  the provider's reverse answer
 * @returns {string[]|null}
 */
export function composeReverseGeocodeAddressLines(response) {
  if (!response || typeof response !== "object") return null;
  const a = addressOf(response);
  const lines = [];
  const seen = new Set();
  const remember = (value) => {
    const key = lower(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const push = (value) => {
    const v = text(value);
    if (v && remember(v)) lines.push(v);
  };

  const way = reverseGeocodeWay(response);
  if (way) push([text(a.house_number), way].filter(Boolean).join(" "));
  else push(reverseGeocodeFeature(response));
  const locality = firstText(a, LOCALITY_KEYS);
  if (locality) push(locality);
  else push(firstText(a, CITY_KEYS));

  // "Queensland 4218": state and postcode share the last line, each shown only
  // if it is a new value.
  const tail = [firstText(a, STATE_KEYS), text(a.postcode)].filter((v) => v && remember(v));
  if (tail.length) lines.push(tail.join(" "));

  return lines.length ? lines : null;
}
