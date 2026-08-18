// src/lib/documentZoom.test.js
//
// THE DOCUMENT ZOOM MODEL, behaviourally: the ladder, its ends, the visual→
// layout compensation the one measurement system needs, and the UI preference
// that is validated on every read so a corrupt or future stored value can
// never render a broken document.
import {
  DEFAULT_DOCUMENT_ZOOM,
  DOCUMENT_ZOOM_LEVELS,
  DOCUMENT_ZOOM_STORAGE_KEY,
  MAX_DOCUMENT_ZOOM,
  MIN_DOCUMENT_ZOOM,
  canZoomIn,
  canZoomOut,
  documentZoomLabel,
  isDefaultDocumentZoom,
  isDocumentZoom,
  layoutPxFromVisualPx,
  loadDocumentZoom,
  normalizeDocumentZoom,
  saveDocumentZoom,
  zoomIn,
  zoomOut,
  zoomScale,
} from "./documentZoom";

const memStorage = (seed = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  };
};

/* ============================ 7. the ladder ============================== */

describe("7. the ladder and its default", () => {
  test("100% is the default and is on the ladder; the ladder ascends with no duplicates", () => {
    expect(DEFAULT_DOCUMENT_ZOOM).toBe(100);
    expect(isDocumentZoom(DEFAULT_DOCUMENT_ZOOM)).toBe(true);
    expect(isDefaultDocumentZoom(100)).toBe(true);
    expect(DOCUMENT_ZOOM_LEVELS).toEqual([...DOCUMENT_ZOOM_LEVELS].sort((a, b) => a - b));
    expect(new Set(DOCUMENT_ZOOM_LEVELS).size).toBe(DOCUMENT_ZOOM_LEVELS.length);
    expect(MIN_DOCUMENT_ZOOM).toBe(75);
    expect(MAX_DOCUMENT_ZOOM).toBe(150);
  });

  test("the CSS factor and the label both derive from the percentage", () => {
    expect(zoomScale(100)).toBe(1);
    expect(zoomScale(125)).toBe(1.25);
    expect(zoomScale(75)).toBe(0.75);
    expect(documentZoomLabel(125)).toBe("125%");
    // A junk value is displayed as the default rather than as "NaN%".
    expect(documentZoomLabel("nonsense")).toBe("100%");
    expect(zoomScale(undefined)).toBe(1);
  });
});

/* ========================= 8/9/10/11/12. stepping ======================== */

describe("8/9. zoom in and out walk the ladder one step at a time", () => {
  test("in", () => {
    expect(zoomIn(75)).toBe(90);
    expect(zoomIn(90)).toBe(100);
    expect(zoomIn(100)).toBe(110);
    expect(zoomIn(110)).toBe(125);
    expect(zoomIn(125)).toBe(150);
  });

  test("out", () => {
    expect(zoomOut(150)).toBe(125);
    expect(zoomOut(125)).toBe(110);
    expect(zoomOut(110)).toBe(100);
    expect(zoomOut(100)).toBe(90);
    expect(zoomOut(90)).toBe(75);
  });

  test("a full round trip returns to exactly where it started", () => {
    let z = DEFAULT_DOCUMENT_ZOOM;
    for (let i = 0; i < 3; i += 1) z = zoomIn(z);
    for (let i = 0; i < 3; i += 1) z = zoomOut(z);
    expect(z).toBe(DEFAULT_DOCUMENT_ZOOM);
  });
});

describe("11/12. the ends clamp rather than wrap or overshoot", () => {
  test("the maximum stays the maximum and reports that it cannot grow", () => {
    expect(zoomIn(MAX_DOCUMENT_ZOOM)).toBe(MAX_DOCUMENT_ZOOM);
    expect(zoomIn(999)).toBe(MAX_DOCUMENT_ZOOM);
    expect(canZoomIn(MAX_DOCUMENT_ZOOM)).toBe(false);
    expect(canZoomIn(125)).toBe(true);
  });

  test("the minimum stays the minimum and reports that it cannot shrink", () => {
    expect(zoomOut(MIN_DOCUMENT_ZOOM)).toBe(MIN_DOCUMENT_ZOOM);
    expect(zoomOut(-40)).toBe(MIN_DOCUMENT_ZOOM);
    expect(canZoomOut(MIN_DOCUMENT_ZOOM)).toBe(false);
    expect(canZoomOut(90)).toBe(true);
  });

  test("10. reset is simply the default, reachable from either end", () => {
    expect(normalizeDocumentZoom(DEFAULT_DOCUMENT_ZOOM)).toBe(100);
    expect(isDefaultDocumentZoom(MAX_DOCUMENT_ZOOM)).toBe(false);
    expect(isDefaultDocumentZoom(MIN_DOCUMENT_ZOOM)).toBe(false);
  });

  test("an off-ladder value snaps to the nearest step; a tie resolves downward", () => {
    expect(normalizeDocumentZoom(101)).toBe(100);
    expect(normalizeDocumentZoom(118)).toBe(125); // 7 away from 125, 8 from 110
    expect(normalizeDocumentZoom(105)).toBe(100); // tie between 100 and 110 → downward
    expect(normalizeDocumentZoom(140)).toBe(150);
  });

  test("anything that is not a usable number reads as 100%, never as an end of the scale", () => {
    for (const value of [null, undefined, NaN, "", "abc", {}, [], true]) {
      expect(normalizeDocumentZoom(value)).toBe(DEFAULT_DOCUMENT_ZOOM);
    }
    // A numeric string IS usable — that is what comes back from storage.
    expect(normalizeDocumentZoom("125")).toBe(125);
  });
});

/* ==================== the one measurement compensation =================== */

describe("layoutPxFromVisualPx — the single zoom compensation", () => {
  test("a client rect measured inside a zoomed subtree converts back to layout pixels", () => {
    expect(layoutPxFromVisualPx(125, 125)).toBe(100);
    expect(layoutPxFromVisualPx(150, 150)).toBe(100);
    expect(layoutPxFromVisualPx(75, 75)).toBe(100);
  });

  test("at 100% it is the identity, so the unzoomed path is byte-for-byte what it always was", () => {
    for (const px of [0, 1, 17.5, 793.7, -20]) {
      expect(layoutPxFromVisualPx(px, 100)).toBe(px);
    }
  });

  test("a page boundary lands at the same layout position at every zoom level", () => {
    // The same block, measured at three zooms, must convert to one height.
    const layoutHeight = 240;
    for (const zoom of DOCUMENT_ZOOM_LEVELS) {
      const visual = layoutHeight * zoomScale(zoom);
      expect(layoutPxFromVisualPx(visual, zoom)).toBeCloseTo(layoutHeight, 9);
    }
  });

  test("unusable input degrades safely rather than producing NaN geometry", () => {
    expect(layoutPxFromVisualPx(NaN, 125)).toBe(0);
    expect(layoutPxFromVisualPx("x", 125)).toBe(0);
    // An unusable ZOOM falls back to the default scale of 1, not to a divide
    // by zero.
    expect(layoutPxFromVisualPx(120, "nonsense")).toBe(120);
  });
});

/* ========================= 13/14. the preference ========================= */

describe("13/14. the remembered UI preference is validated on every read", () => {
  test("13. a chosen zoom round-trips through storage under its own key", () => {
    const storage = memStorage();
    expect(loadDocumentZoom(storage)).toBe(DEFAULT_DOCUMENT_ZOOM);
    saveDocumentZoom(125, storage);
    expect(loadDocumentZoom(storage)).toBe(125);
    expect(Object.keys(storage.dump())).toEqual([DOCUMENT_ZOOM_STORAGE_KEY]);
  });

  test("14. a corrupt, out-of-range, off-ladder or future stored value falls back safely", () => {
    expect(loadDocumentZoom(memStorage({ [DOCUMENT_ZOOM_STORAGE_KEY]: "banana" }))).toBe(100);
    expect(loadDocumentZoom(memStorage({ [DOCUMENT_ZOOM_STORAGE_KEY]: "" }))).toBe(100);
    expect(loadDocumentZoom(memStorage({ [DOCUMENT_ZOOM_STORAGE_KEY]: "9000" }))).toBe(MAX_DOCUMENT_ZOOM);
    expect(loadDocumentZoom(memStorage({ [DOCUMENT_ZOOM_STORAGE_KEY]: "-5" }))).toBe(MIN_DOCUMENT_ZOOM);
    // A value a FUTURE version might introduce snaps onto this version's ladder.
    expect(loadDocumentZoom(memStorage({ [DOCUMENT_ZOOM_STORAGE_KEY]: "200" }))).toBe(MAX_DOCUMENT_ZOOM);
    expect(isDocumentZoom(loadDocumentZoom(memStorage({ [DOCUMENT_ZOOM_STORAGE_KEY]: "137" })))).toBe(true);
  });

  test("a saved value is normalized before it is written, so storage never holds junk", () => {
    const storage = memStorage();
    saveDocumentZoom(9000, storage);
    expect(storage.getItem(DOCUMENT_ZOOM_STORAGE_KEY)).toBe(String(MAX_DOCUMENT_ZOOM));
    saveDocumentZoom("nonsense", storage);
    expect(storage.getItem(DOCUMENT_ZOOM_STORAGE_KEY)).toBe(String(DEFAULT_DOCUMENT_ZOOM));
  });

  test("missing or throwing storage never throws and never blocks the document", () => {
    expect(loadDocumentZoom(null)).toBe(DEFAULT_DOCUMENT_ZOOM);
    expect(() => saveDocumentZoom(125, null)).not.toThrow();
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadDocumentZoom(hostile)).toBe(DEFAULT_DOCUMENT_ZOOM);
    expect(() => saveDocumentZoom(125, hostile)).not.toThrow();
  });

  test("19. the preference is a bare number under ONE key — it carries no note, template or document data", () => {
    const storage = memStorage();
    saveDocumentZoom(150, storage);
    const dump = storage.dump();
    expect(Object.keys(dump)).toHaveLength(1);
    // A bare number — no id, no note title, no document content of any kind.
    expect(dump[DOCUMENT_ZOOM_STORAGE_KEY]).toBe("150");
    expect(Number.isFinite(Number(dump[DOCUMENT_ZOOM_STORAGE_KEY]))).toBe(true);
    // ONE global key: it is not scoped to a note, template or project id, so
    // zoom follows the person rather than becoming a property of a document.
    expect(DOCUMENT_ZOOM_STORAGE_KEY).toBe("notewise-document-zoom-v1");
  });
});
