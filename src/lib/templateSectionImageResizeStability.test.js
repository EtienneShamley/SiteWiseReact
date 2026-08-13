// src/lib/templateSectionImageResizeStability.test.js
//
// REGRESSION — manual test, 2026-08-13: "add an image with the CAMERA icon, then
// resize it from a corner. The first gesture can work. After that, merely moving
// the cursor onto the corner handle makes the image jump smaller, then larger,
// then smaller — it flickers between sizes without any intentional drag."
//
// THE DEFECT. `pointermove` / `pointerup` / `pointercancel` were bound to the
// CORNER HANDLE. A handle is a ~20px box pinned to an edge of the very frame the
// gesture is resizing, and the image's height is DERIVED from its width
// (dH = dW / aspectRatio) — so a bottom handle travels vertically as the pointer
// travels horizontally, and for a portrait image it travels FASTER than the
// pointer does. The pointer therefore leaves the handle mid-drag, `pointerup`
// was delivered somewhere else, and the gesture record (`resizeState.current`)
// was never cleared. From then on the record stayed set, and the move handler —
// which was gated ONLY on that record, with no button check and no pointer-id
// check — recomputed a width on every HOVER from the previous gesture's origin.
// That is the flicker: two different stale origins producing two different
// widths as the cursor crossed the handle.
//
// WHY CAMERA FIRST. Nothing about camera metadata. A stamped photo keeps its
// source dimensions exactly (`buildStampedImageBLOB` draws onto a canvas sized
// `img.width × img.height`), so its intrinsic dimensions and its stored width
// are consistent. The camera is simply the path that reliably produces a TALL
// PORTRAIT image, and portrait is where the bottom handle outruns the pointer by
// the widest margin. The arithmetic is asserted below.
//
// THE FIX. One window-bound listener set that exists only while a gesture is in
// flight, one exit that clears the record first, an immutable gesture record
// captured at pointerdown, and a pointer-id + buttons guard. There is no
// debounce, no threshold and no camera-specific branch.
//
// Component-level facts are asserted against the source: this project has no DOM
// testing library (docs/TESTING.md). The arithmetic itself is proved in
// templateSectionImageResize.test.js and is unchanged by this fix.

import fs from "fs";
import path from "path";

import {
  IMAGE_RESIZE_CORNER,
  IMAGE_RESIZE_CORNERS,
  cornerGrowsRightward,
  resizeWidthPctFromPointer,
  widthPctChanged,
} from "./templateSectionImageResize";
import { IMAGE_CORNER_ZONE_PX } from "./templateSectionImageMove";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const photoRaw = read("components/template/PhotoAttachment.js");
const photo = withoutComments(photoRaw);
const bottomBar = withoutComments(read("components/BottomBar.js"));

const between = (source, from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

// The window-bound gesture effect, where move/end now live.
const gestureEffect = () =>
  between(photo, "if (!resizing) return undefined;", "}, [resizing,");
const pointerDown = () =>
  between(photo, "const onCornerPointerDown", "if (!resizing) return undefined;");
const endFn = () => between(photo, "const endCornerResize", "const onCornerPointerDown");
// The one width calculation, shared by the move preview and the commit.
const pctFn = () => between(photo, "const cornerPctFor", "const endCornerResize");

/* -------------------------------------------------------------------------- */
/* The gesture model under test — the exact rule the component now follows.    */
/* -------------------------------------------------------------------------- */

// A faithful, minimal model of the component's gesture: an immutable record
// captured at pointerdown, a preview derived only from that record plus the
// live pointer x, and one exit that clears the record first. It lets the
// SEQUENCE (hover, press, drag, release, hover again, press again) be exercised
// without a DOM, which is the only way to prove "the second resize starts from
// the persisted width" and "hover after release changes nothing".
function makeResizer({ widthPct = 100, containerWidth = 490, maxPct = null } = {}) {
  const saves = [];
  let persisted = widthPct;
  let state = null; // the gesture record; null = no gesture
  let preview = null;
  let listening = false; // whether the window listeners exist

  const api = {
    saves,
    get persisted() {
      return persisted;
    },
    get rendered() {
      return preview ?? persisted;
    },
    get active() {
      return state !== null;
    },
    get listening() {
      return listening;
    },

    pointerDown({ corner, clientX, pointerId = 1, button = 0 }) {
      if (button !== 0) return;
      state = {
        pointerId,
        corner,
        startX: clientX,
        startPct: persisted,
        containerWidth,
        maxPct,
      };
      listening = true;
      preview = state.startPct; // starts at the width it already has
    },

    // The window listener: it only exists while a gesture does.
    pointerMove({ clientX, pointerId = 1, buttons = 1 }) {
      if (!listening) return;
      if (!state || pointerId !== state.pointerId) return;
      if (buttons === 0) {
        api.end({ clientX, pointerId });
        return;
      }
      const pct = resizeWidthPctFromPointer({
        corner: state.corner,
        startWidthPct: state.startPct,
        startX: state.startX,
        clientX,
        containerWidth: state.containerWidth,
        maxPct: state.maxPct,
      });
      if (pct != null) preview = pct;
    },

    end({ clientX, pointerId = 1 }) {
      if (!state || pointerId !== state.pointerId) return;
      const st = state;
      state = null;
      listening = false;
      preview = null;
      const pct = resizeWidthPctFromPointer({
        corner: st.corner,
        startWidthPct: st.startPct,
        startX: st.startX,
        clientX,
        containerWidth: st.containerWidth,
        maxPct: st.maxPct,
      });
      if (pct == null) return;
      if (!widthPctChanged(pct, st.startPct)) return;
      const next = Math.round(pct);
      saves.push(next);
      persisted = next;
    },

    abort() {
      if (!state) return;
      state = null;
      listening = false;
      preview = null;
    },
  };
  return api;
}

/* ========================================================================== */
/* 1–4. NOTHING HAPPENS WITHOUT AN INTENTIONAL DRAG                            */
/* ========================================================================== */

describe("1–4. hover and press alone never change the width", () => {
  test("1. merely hovering the resize handle changes no width", () => {
    const r = makeResizer({ widthPct: 60 });
    r.pointerMove({ clientX: 100 });
    r.pointerMove({ clientX: 140 });
    r.pointerMove({ clientX: 180 });
    expect(r.rendered).toBe(60);
    expect(r.saves).toEqual([]);
  });

  test("2. a pointer ENTERING the handle changes no width — there are no listeners at all", () => {
    const r = makeResizer({ widthPct: 60 });
    expect(r.listening).toBe(false);
    // The component adds its move listener inside `if (!resizing) return undefined;`
    // so with no gesture in flight there is nothing bound to the window.
    expect(gestureEffect()).toMatch(/window\.addEventListener\("pointermove", onMove\)/);
    expect(photo).toMatch(/if \(!resizing\) return undefined;/);
    r.pointerMove({ clientX: 999 });
    expect(r.rendered).toBe(60);
  });

  test("3. pointerdown with ZERO movement changes no width and saves nothing", () => {
    const r = makeResizer({ widthPct: 60 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 300 });
    expect(r.rendered).toBe(60);
    r.end({ clientX: 300 });
    expect(r.rendered).toBe(60);
    expect(r.saves).toEqual([]);
  });

  test("4. sub-threshold movement (under half a percentage point) saves nothing", () => {
    const r = makeResizer({ widthPct: 60, containerWidth: 490 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 300 });
    r.pointerMove({ clientX: 302 }); // 2px of 490 = 0.4pct
    r.end({ clientX: 302 });
    expect(r.saves).toEqual([]);
    expect(r.persisted).toBe(60);
  });
});

/* ========================================================================== */
/* 5–11. THE REGRESSION ITSELF — repeated resizes stay stable                   */
/* ========================================================================== */

describe("5–11. repeated resizing is stable", () => {
  test("5. the first resize works", () => {
    const r = makeResizer({ widthPct: 100, containerWidth: 490 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
    r.pointerMove({ clientX: 300 }); // 100px narrower ≈ 20.4pct
    expect(Math.round(r.rendered)).toBe(80);
    r.end({ clientX: 300 });
    expect(r.saves).toEqual([80]);
    expect(r.persisted).toBe(80);
  });

  test("6. release clears the active gesture state completely", () => {
    const r = makeResizer({ widthPct: 100 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
    r.pointerMove({ clientX: 300 });
    r.end({ clientX: 300 });
    expect(r.active).toBe(false);
    expect(r.listening).toBe(false);
  });

  test("7. HOVERING the handle after the first resize changes nothing", () => {
    const r = makeResizer({ widthPct: 100, containerWidth: 490 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
    r.pointerMove({ clientX: 300 });
    r.end({ clientX: 300 });

    // THE REPORTED SYMPTOM: cursor merely reaches the handle again.
    for (const x of [305, 260, 420, 300, 380]) r.pointerMove({ clientX: x });
    expect(r.rendered).toBe(80);
    expect(r.saves).toEqual([80]);
  });

  test("8. pointermove after release changes nothing, however far it travels", () => {
    const r = makeResizer({ widthPct: 100, containerWidth: 490 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.TOP_LEFT, clientX: 100 });
    r.pointerMove({ clientX: 150 });
    r.end({ clientX: 150 });
    const after = r.persisted;
    r.pointerMove({ clientX: -500 });
    r.pointerMove({ clientX: 5000 });
    expect(r.rendered).toBe(after);
    expect(r.saves).toHaveLength(1);
  });

  test("9. the second resize starts from the PERSISTED width, not the original one", () => {
    const r = makeResizer({ widthPct: 100, containerWidth: 490 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
    r.pointerMove({ clientX: 300 });
    r.end({ clientX: 300 }); // -> 80

    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
    // A press alone must render the width it already has — 80, never 100.
    expect(r.rendered).toBe(80);
    r.pointerMove({ clientX: 350 });
    expect(Math.round(r.rendered)).toBe(70);
    r.end({ clientX: 350 });
    expect(r.saves).toEqual([80, 70]);
  });

  test("10. the second resize is smooth — every step follows the pointer monotonically", () => {
    const r = makeResizer({ widthPct: 100, containerWidth: 490 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
    r.pointerMove({ clientX: 300 });
    r.end({ clientX: 300 });

    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
    const seen = [];
    for (let x = 400; x >= 320; x -= 10) {
      r.pointerMove({ clientX: x });
      seen.push(r.rendered);
    }
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeLessThan(seen[i - 1]);
    }
  });

  test("11. FOUR consecutive resizes never alternate between two prior sizes", () => {
    const r = makeResizer({ widthPct: 100, containerWidth: 490 });
    // Each gesture presses at the same x and drags 50px inward.
    for (let i = 0; i < 4; i += 1) {
      r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
      r.pointerMove({ clientX: 350 });
      // …and the pointer wanders well off the handle before releasing, which is
      // exactly what used to strand the gesture.
      r.pointerMove({ clientX: 349 });
      r.end({ clientX: 349 });
      // A hover between gestures, which used to be the flicker.
      r.pointerMove({ clientX: 380 });
      r.pointerMove({ clientX: 300 });
    }
    // Strictly decreasing: no value is ever revisited, so nothing alternated.
    expect(r.saves).toEqual([...r.saves].sort((a, b) => b - a));
    expect(new Set(r.saves).size).toBe(r.saves.length);
    expect(r.saves).toHaveLength(4);
  });
});

/* ========================================================================== */
/* 12–15. THE IMMUTABLE GESTURE RECORD                                         */
/* ========================================================================== */

describe("12–15. the gesture basis is captured once and never re-derived", () => {
  test("12. the corner captured at pointerdown decides direction for the WHOLE gesture", () => {
    // A left corner grows leftward for every step, even after the pointer has
    // crossed to the other side of where it started.
    const r = makeResizer({ widthPct: 60, containerWidth: 490 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.TOP_LEFT, clientX: 300 });
    r.pointerMove({ clientX: 250 }); // left -> bigger
    const bigger = r.rendered;
    r.pointerMove({ clientX: 350 }); // right -> smaller
    const smaller = r.rendered;
    expect(bigger).toBeGreaterThan(60);
    expect(smaller).toBeLessThan(60);
    expect(cornerGrowsRightward(IMAGE_RESIZE_CORNER.TOP_LEFT)).toBe(false);

    // The component reads the corner from the RECORD, never from the event.
    expect(pctFn()).toMatch(/corner: st\.corner/);
    expect(gestureEffect()).not.toMatch(/e\.target|currentTarget/);
  });

  test("13. the preview never becomes the next basis — width is a pure function of startPct + dx", () => {
    // Replaying the same pointer path always lands on the same width, which is
    // only true if the preview is not fed back in.
    const path = [380, 340, 300, 340, 380, 300];
    const run = () => {
      const r = makeResizer({ widthPct: 100, containerWidth: 490 });
      r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
      const seen = [];
      for (const x of path) {
        r.pointerMove({ clientX: x });
        seen.push(r.rendered);
      }
      return seen;
    };
    expect(run()).toEqual(run());
    // Returning to an earlier x returns to that x's width exactly.
    const seen = run();
    expect(seen[2]).toBe(seen[5]); // both at clientX 300
    expect(seen[1]).toBe(seen[3]); // both at clientX 340

    expect(pctFn()).toMatch(/startWidthPct: st\.startPct/);
    expect(pctFn()).toMatch(/startX: st\.startX/);
  });

  test("14. the content width is measured ONCE, at pointerdown", () => {
    const down = pointerDown();
    expect(down).toMatch(/const limits = resizeLimits\(\);/);
    expect(down).toMatch(/containerWidth: limits\.containerWidth/);
    // …and the move path reads it from the record, never re-measuring.
    expect(pctFn()).toMatch(/containerWidth: st\.containerWidth/);
    expect(gestureEffect()).not.toMatch(/resizeLimits\(\)|getBoundingClientRect/);
    expect(pctFn()).not.toMatch(/resizeLimits\(\)|getBoundingClientRect/);
  });

  test("15. the one-page-height cap is captured once per gesture, from stable intrinsics", () => {
    const down = pointerDown();
    expect(down).toMatch(/maxPct: limits\.maxPct/);
    expect(pctFn()).toMatch(/maxPct: st\.maxPct/);
    expect(pctFn()).not.toMatch(/maxWidthPx/);
    expect(gestureEffect()).not.toMatch(/maxWidthPx/);
    // The cap comes from the attachment's INTRINSIC dimensions — never from the
    // rendered preview box — so it cannot oscillate with the width it bounds.
    expect(photo).toMatch(
      /const ratio =\s*attachment\.intrinsicWidth > 0 && attachment\.intrinsicHeight > 0/
    );
    expect(photo).toMatch(/maxWidthPx = ratio \? Math\.floor\(PHOTO_MAX_HEIGHT_PX \* ratio\) : null/);

    // A capped gesture saturates and STAYS saturated — it never snaps back.
    const r = makeResizer({ widthPct: 60, containerWidth: 490, maxPct: 80 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 300 });
    const widths = [];
    for (let x = 300; x <= 600; x += 25) {
      r.pointerMove({ clientX: x });
      widths.push(r.rendered);
    }
    expect(Math.max(...widths)).toBe(80);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    }
  });
});

/* ========================================================================== */
/* 16–19. CAMERA vs NORMAL UPLOAD, AND BOTH CORNER SIDES                       */
/* ========================================================================== */

describe("16–19. camera and upload, left and right", () => {
  // The shape difference the manual report surfaced on. A camera capture is
  // PORTRAIT; an ordinary upload is usually landscape. Nothing else differs —
  // the stamp preserves the source dimensions exactly (asserted below).
  const CAMERA = { intrinsicWidth: 3024, intrinsicHeight: 4032 }; // 3:4 portrait
  const UPLOAD = { intrinsicWidth: 4032, intrinsicHeight: 3024 }; // 4:3 landscape

  const repeatedResizes = (opts) => {
    const r = makeResizer(opts);
    for (let i = 0; i < 5; i += 1) {
      r.pointerDown({ corner: opts.corner, clientX: 400 });
      r.pointerMove({ clientX: 400 + (cornerGrowsRightward(opts.corner) ? -30 : 30) });
      // The pointer leaves the handle's neighbourhood before release.
      r.pointerMove({ clientX: 400 + (cornerGrowsRightward(opts.corner) ? -31 : 31) });
      r.end({ clientX: 400 + (cornerGrowsRightward(opts.corner) ? -31 : 31) });
      // …then wanders back across it.
      r.pointerMove({ clientX: 400 });
      r.pointerMove({ clientX: 360 });
    }
    return r;
  };

  test("16. a CAMERA-STAMPED photo survives five consecutive resizes without flicker", () => {
    const r = repeatedResizes({
      widthPct: 100,
      containerWidth: 490,
      corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT,
    });
    expect(r.saves).toHaveLength(5);
    expect(new Set(r.saves).size).toBe(5);
    expect(r.saves).toEqual([...r.saves].sort((a, b) => b - a));
    expect(r.active).toBe(false);
  });

  test("17. a NORMAL uploaded photo behaves identically", () => {
    const r = repeatedResizes({
      widthPct: 100,
      containerWidth: 490,
      corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT,
    });
    expect(r.saves).toHaveLength(5);
    expect(new Set(r.saves).size).toBe(5);
    expect(r.active).toBe(false);
  });

  test("the shape difference is REAL and is why camera surfaced it first", () => {
    // Height is derived from width, so a horizontal drag moves the BOTTOM edge
    // by dW / ratio. For a portrait capture that is ~1.8x the pointer's own
    // travel; for a landscape upload it is ~0.56x. A handle is only
    // IMAGE_CORNER_ZONE_PX across, so the portrait case leaves it far sooner —
    // which is what made the missed `pointerup` reproducible on camera images.
    const drag = 40;
    const cameraRatio = CAMERA.intrinsicWidth / CAMERA.intrinsicHeight;
    const uploadRatio = UPLOAD.intrinsicWidth / UPLOAD.intrinsicHeight;
    const cameraEdgeTravel = drag / cameraRatio;
    const uploadEdgeTravel = drag / uploadRatio;
    expect(cameraEdgeTravel).toBeGreaterThan(uploadEdgeTravel);
    expect(cameraEdgeTravel).toBeGreaterThan(IMAGE_CORNER_ZONE_PX);
    expect(cameraEdgeTravel / uploadEdgeTravel).toBeGreaterThan(1.7);

    // And it is ONLY a shape difference: stamping copies the source dimensions,
    // so a camera photo's intrinsics are consistent with its stored bytes and
    // NO camera-specific resize logic exists.
    expect(bottomBar).toMatch(/const maxW = img\.width, maxH = img\.height;/);
    expect(bottomBar).toMatch(/stampedCanvas\.width = maxW; stampedCanvas\.height = maxH;/);
    expect(photo).not.toMatch(/camera|stamp/i);
  });

  test("18. repeated resizing from a LEFT corner is stable", () => {
    for (const corner of [IMAGE_RESIZE_CORNER.TOP_LEFT, IMAGE_RESIZE_CORNER.BOTTOM_LEFT]) {
      const r = repeatedResizes({ widthPct: 100, containerWidth: 490, corner });
      expect(r.saves).toHaveLength(5);
      expect(new Set(r.saves).size).toBe(5);
      expect(r.active).toBe(false);
    }
  });

  test("19. repeated resizing from a RIGHT corner is stable", () => {
    for (const corner of [IMAGE_RESIZE_CORNER.TOP_RIGHT, IMAGE_RESIZE_CORNER.BOTTOM_RIGHT]) {
      const r = repeatedResizes({ widthPct: 100, containerWidth: 490, corner });
      expect(r.saves).toHaveLength(5);
      expect(new Set(r.saves).size).toBe(5);
      expect(r.active).toBe(false);
    }
    expect(IMAGE_RESIZE_CORNERS).toHaveLength(4);
  });
});

/* ========================================================================== */
/* 20–21. ONE SAVE, AND CLEAN ABANDONMENT                                      */
/* ========================================================================== */

describe("20–21. persistence and abandonment", () => {
  test("20. one release is exactly ONE persistence call, however many moves preceded it", () => {
    const r = makeResizer({ widthPct: 100, containerWidth: 490 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
    for (let x = 400; x >= 300; x -= 5) r.pointerMove({ clientX: x });
    expect(r.saves).toEqual([]); // preview only
    r.end({ clientX: 300 });
    expect(r.saves).toHaveLength(1);
  });

  test("21. pointercancel and Escape clear the state and save nothing", () => {
    const r = makeResizer({ widthPct: 100, containerWidth: 490 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
    r.pointerMove({ clientX: 300 });
    r.abort();
    expect(r.saves).toEqual([]);
    expect(r.persisted).toBe(100);
    expect(r.rendered).toBe(100); // the preview is dropped, the stored width shows
    expect(r.active).toBe(false);
    // …and a later hover still does nothing.
    r.pointerMove({ clientX: 200 });
    expect(r.rendered).toBe(100);

    expect(gestureEffect()).toMatch(/window\.addEventListener\("pointercancel", onAbort\)/);
    expect(gestureEffect()).toMatch(/if \(e\.key === "Escape"\) endCornerResize\(null\)/);
  });

  test("a release that was never observed still ends the gesture (buttons === 0)", () => {
    const r = makeResizer({ widthPct: 100, containerWidth: 490 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400 });
    r.pointerMove({ clientX: 300 });
    // The button came up without a pointerup reaching us.
    r.pointerMove({ clientX: 300, buttons: 0 });
    expect(r.active).toBe(false);
    expect(r.saves).toEqual([80]);
    // And from here, hovering does nothing at all.
    r.pointerMove({ clientX: 400 });
    r.pointerMove({ clientX: 200 });
    expect(r.rendered).toBe(80);
    expect(r.saves).toEqual([80]);

    expect(gestureEffect()).toMatch(/if \(e\.buttons === 0\)/);
  });

  test("a DIFFERENT pointer can never drive the gesture", () => {
    const r = makeResizer({ widthPct: 100, containerWidth: 490 });
    r.pointerDown({ corner: IMAGE_RESIZE_CORNER.BOTTOM_RIGHT, clientX: 400, pointerId: 1 });
    r.pointerMove({ clientX: 200, pointerId: 2 });
    expect(r.rendered).toBe(100);
    r.end({ clientX: 200, pointerId: 2 });
    expect(r.saves).toEqual([]);
    expect(r.active).toBe(true);

    expect(pointerDown()).toMatch(/pointerId: e\.pointerId/);
    expect(gestureEffect()).toMatch(/e\.pointerId === st\.pointerId/);
  });
});

/* ========================================================================== */
/* 22–26. NOTHING ELSE MOVED                                                   */
/* ========================================================================== */

describe("22–26. the surrounding gestures and data are untouched", () => {
  test("22. the image BODY still starts a move", () => {
    expect(photo).toMatch(/onPointerDown=\{onMoveStart \? handleImagePointerDown : undefined\}/);
    expect(photo).toMatch(/isImageMoveSurface\(\{ rect, clientX: e\.clientX, clientY: e\.clientY \}\)/);
    expect(photo).toMatch(/onMoveStart\(e\)/);
  });

  test("23. a corner press still cannot become a body move", () => {
    const down = pointerDown();
    expect(down).toMatch(/e\.preventDefault\(\)/);
    expect(down).toMatch(/e\.stopPropagation\(\)/);
    // The move surface declines the corner zone independently.
    expect(photo).toMatch(/if \(!isImageMoveSurface\(\{[\s\S]{0,120}?\)\) return;/);
  });

  test("24. Open larger still fires only from its own button", () => {
    expect(photo).toMatch(/aria-label=\{`Open larger preview of \$\{name\}`\}/);
    expect(photo).toMatch(/onClick=\{\(\) => setPreview\(true\)\}/);
    expect(pointerDown()).not.toMatch(/setPreview/);
    expect(gestureEffect()).not.toMatch(/setPreview/);
  });

  test("25. the resize writes widthPct only — no height, no sectionExtraHeight", () => {
    const end = endFn();
    expect(end).toMatch(/onResizeWidth\(Math\.round\(pct\)\)/);
    expect(end).not.toMatch(/height|alignment|sectionExtraHeight/i);
    const templateDoc = withoutComments(read("components/template/NoteTemplateDoc.js"));
    const resize = between(templateDoc, "const resizeSectionPhoto", "const reorderSectionContentItem");
    expect(resize).toMatch(/patch: \{ widthPct \}/);
    expect(resize).not.toMatch(/sectionExtraHeight/);
  });

  test("26. the item's id and assetId are never part of a resize", () => {
    const end = endFn();
    expect(end).not.toMatch(/assetId|item\.id/);
    // The primitive preserves them; that rule lives in one place.
    const attachments = withoutComments(read("lib/templateSectionAttachments.js"));
    expect(attachments).toMatch(/normalizeDisplay\(\{ \.\.\.entry\.display, \.\.\.patch \}\)/);
  });

  test("the handle itself now receives POINTERDOWN and nothing else", () => {
    const corners = between(photo, "IMAGE_RESIZE_CORNERS.map((corner)", "{preview &&");
    expect(corners).toMatch(/onPointerDown=\{onCornerPointerDown\(corner\)\}/);
    expect(corners).not.toMatch(/onPointerMove=|onPointerUp=|onPointerCancel=/);
  });

  test("there is ONE listener system for the gesture, and it is torn down with it", () => {
    const effect = gestureEffect();
    const added = effect.match(/window\.addEventListener\(/g) || [];
    const removed = effect.match(/window\.removeEventListener\(/g) || [];
    expect(added).toHaveLength(4); // pointermove, pointerup, pointercancel, keydown
    expect(removed).toHaveLength(added.length);
    // No competing document-level or mouse-event system for the same gesture.
    expect(effect).not.toMatch(/document\.addEventListener|mousemove|mouseup/);
  });
});
