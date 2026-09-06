// src/lib/reverseGeocodeAddress.test.js
//
// The camera stamp's address lines, composed from realistic Nominatim
// `jsonv2` + `addressdetails=1` reverse responses. No network: the fixtures
// are the shapes the provider actually returns, including the one honest
// answer for a photograph taken on the Broadbeach promenade — "Gold Coast
// Oceanway", which IS what that coordinate resolves to.
import {
  NOMINATIM_REVERSE_ENDPOINT,
  composeReverseGeocodeAddressLines,
  nominatimReverseUrl,
  reverseGeocodeFeature,
  reverseGeocodeWay,
} from "./reverseGeocodeAddress";

/* ------------------------------- fixtures -------------------------------- */

const AU = {
  state: "Queensland",
  "ISO3166-2-lvl4": "AU-QLD",
  postcode: "4218",
  country: "Australia",
  country_code: "au",
};

// The real case: the photograph was taken on the beachfront shared path.
const OCEANWAY = {
  place_id: 1,
  osm_type: "way",
  osm_id: 1,
  lat: "-28.033044",
  lon: "153.436219",
  category: "highway",
  type: "cycleway",
  place_rank: 27,
  addresstype: "road",
  name: "Gold Coast Oceanway",
  display_name: "Gold Coast Oceanway, Broadbeach, Gold Coast, Queensland, 4218, Australia",
  address: {
    road: "Gold Coast Oceanway",
    suburb: "Broadbeach",
    city: "Gold Coast",
    ...AU,
  },
};

// An addressed building: house number + street.
const HOUSE = {
  place_id: 3,
  category: "building",
  type: "yes",
  place_rank: 30,
  addresstype: "building",
  name: "",
  address: {
    house_number: "61",
    road: "Peninsula Drive",
    suburb: "Robina",
    city: "Gold Coast",
    ...AU,
    postcode: "4226",
  },
};

// A park with a parent street: the street is the address, the park is not.
const PARK = {
  place_id: 4,
  category: "leisure",
  type: "park",
  place_rank: 30,
  addresstype: "leisure",
  name: "Kurrawa Park",
  address: {
    leisure: "Kurrawa Park",
    road: "Old Burleigh Road",
    suburb: "Broadbeach",
    city: "Gold Coast",
    ...AU,
  },
};

// A beach with no way anywhere in the answer: the feature is the first line.
const BEACH = {
  place_id: 5,
  category: "natural",
  type: "beach",
  place_rank: 30,
  addresstype: "natural",
  name: "Kurrawa Beach",
  address: { natural: "Kurrawa Beach", suburb: "Broadbeach", city: "Gold Coast", ...AU },
};

/* --------------------------------- URL ----------------------------------- */

describe("the lookup URL", () => {
  test("is the provider's reverse endpoint with structured address details, and nothing else", () => {
    const url = new URL(nominatimReverseUrl(-28.033044, 153.436219));
    expect(`${url.origin}${url.pathname}`).toBe(NOMINATIM_REVERSE_ENDPOINT);
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("lat")).toBe("-28.033044");
    expect(url.searchParams.get("lon")).toBe("153.436219");
    expect(url.searchParams.get("addressdetails")).toBe("1");
    // One honest answer at the provider's default level: no zoom is forced to
    // pull a path coordinate onto a nearby street.
    expect(url.searchParams.has("zoom")).toBe(false);
    expect([...url.searchParams.keys()].sort()).toEqual(["addressdetails", "format", "lat", "lon"]);
  });
});

/* ---------------------------- the first line ------------------------------ */

describe("what the coordinate resolves to", () => {
  test("the way is whatever the provider labelled — a street or genuinely a path", () => {
    expect(reverseGeocodeWay(OCEANWAY)).toBe("Gold Coast Oceanway");
    expect(reverseGeocodeWay(HOUSE)).toBe("Peninsula Drive");
    expect(reverseGeocodeWay(PARK)).toBe("Old Burleigh Road");
    expect(reverseGeocodeWay(BEACH)).toBeNull();
    // Older releases' own labels for a pedestrian street or a path.
    expect(reverseGeocodeWay({ address: { pedestrian: "Cavill Avenue" } })).toBe("Cavill Avenue");
    expect(reverseGeocodeWay({ address: { footway: "Beach Track" } })).toBe("Beach Track");
    expect(reverseGeocodeWay(null)).toBeNull();
  });

  test("the feature is the named thing the point is on", () => {
    expect(reverseGeocodeFeature(BEACH)).toBe("Kurrawa Beach");
    expect(reverseGeocodeFeature(PARK)).toBe("Kurrawa Park");
    // No top-level name: the address's own label for the object's type/class.
    expect(reverseGeocodeFeature({ ...BEACH, name: "" })).toBe("Kurrawa Beach");
    expect(reverseGeocodeFeature({ category: "leisure", type: "park", address: { leisure: "Pratten Park" } })).toBe(
      "Pratten Park"
    );
    expect(reverseGeocodeFeature({ address: {} })).toBeNull();
    expect(reverseGeocodeFeature(null)).toBeNull();
  });
});

/* ------------------------------ composition ------------------------------ */

describe("composing the stamp's address lines", () => {
  test("house number + road wins, followed by suburb and 'State postcode' — the city is omitted beneath a suburb", () => {
    expect(composeReverseGeocodeAddressLines(HOUSE)).toEqual([
      "61 Peninsula Drive",
      "Robina",
      "Queensland 4226",
    ]);
  });

  test("with no suburb/locality the city or town takes that line", () => {
    const { suburb, ...withoutSuburb } = HOUSE.address;
    expect(composeReverseGeocodeAddressLines({ ...HOUSE, address: withoutSuburb })).toEqual([
      "61 Peninsula Drive",
      "Gold Coast",
      "Queensland 4226",
    ]);
    expect(composeReverseGeocodeAddressLines({ address: { road: "High Street", town: "Hastings" } })).toEqual([
      "High Street",
      "Hastings",
    ]);
  });

  test("a road wins over the feature it is the parent of", () => {
    expect(composeReverseGeocodeAddressLines(PARK)).toEqual([
      "Old Burleigh Road",
      "Broadbeach",
      "Queensland 4218",
    ]);
  });

  test("THE CASE: the promenade the photograph was taken on is kept honestly", () => {
    expect(composeReverseGeocodeAddressLines(OCEANWAY)).toEqual([
      "Gold Coast Oceanway",
      "Broadbeach",
      "Queensland 4218",
    ]);
  });

  test("with no way at all the feature leads", () => {
    expect(composeReverseGeocodeAddressLines(BEACH)).toEqual([
      "Kurrawa Beach",
      "Broadbeach",
      "Queensland 4218",
    ]);
  });

  test("equivalent values repeated through the hierarchy appear once", () => {
    const repeated = {
      ...OCEANWAY,
      address: { road: "Surf Parade", suburb: "Gold Coast", city: "Gold Coast", county: "Gold Coast", ...AU },
    };
    expect(composeReverseGeocodeAddressLines(repeated)).toEqual(["Surf Parade", "Gold Coast", "Queensland 4218"]);
    // Case and whitespace do not make two values different.
    const cased = { ...repeated, address: { ...repeated.address, suburb: " gold coast " } };
    expect(composeReverseGeocodeAddressLines(cased)).toEqual(["Surf Parade", "gold coast", "Queensland 4218"]);
    // A feature that IS the locality is not said twice.
    const locality = {
      category: "place",
      type: "suburb",
      name: "Broadbeach",
      address: { suburb: "Broadbeach", city: "Gold Coast", ...AU },
    };
    expect(composeReverseGeocodeAddressLines(locality)).toEqual(["Broadbeach", "Queensland 4218"]);
    // A state that repeats the city is dropped from the last line too.
    const cityState = { address: { road: "Main Road", city: "Singapore", state: "Singapore", postcode: "018956" } };
    expect(composeReverseGeocodeAddressLines(cityState)).toEqual(["Main Road", "Singapore", "018956"]);
  });

  test("a partial answer stays readable", () => {
    expect(composeReverseGeocodeAddressLines({ address: { state: "Queensland" } })).toEqual(["Queensland"]);
    expect(composeReverseGeocodeAddressLines({ address: { postcode: 4218 } })).toEqual(["4218"]);
    expect(composeReverseGeocodeAddressLines({ address: { road: "Surf Parade", postcode: "4218" } })).toEqual([
      "Surf Parade",
      "4218",
    ]);
    // Alternative level names the provider uses in other places.
    expect(
      composeReverseGeocodeAddressLines({
        address: { road: "High Street", neighbourhood: "Old Town", town: "Hastings", region: "South East", postcode: "TN34" },
      })
    ).toEqual(["High Street", "Old Town", "South East TN34"]);
  });

  test("a failed or empty lookup composes to null, never to a made-up line", () => {
    expect(composeReverseGeocodeAddressLines(null)).toBeNull();
    expect(composeReverseGeocodeAddressLines(undefined)).toBeNull();
    expect(composeReverseGeocodeAddressLines({})).toBeNull();
    expect(composeReverseGeocodeAddressLines({ error: "Unable to geocode" })).toBeNull();
    expect(composeReverseGeocodeAddressLines({ address: { road: "   ", suburb: "" } })).toBeNull();
    expect(composeReverseGeocodeAddressLines("Surf Parade")).toBeNull();
  });

  test("only strings and finite numbers become lines", () => {
    const hostile = {
      address: { road: ["Surf", "Parade"], suburb: { name: "Broadbeach" }, city: 12.5, state: null, postcode: NaN },
    };
    expect(composeReverseGeocodeAddressLines(hostile)).toEqual(["12.5"]);
  });
});
