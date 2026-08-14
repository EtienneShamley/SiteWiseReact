// src/lib/editorMediaDragGhost.test.js
//
// The floating drag preview, proven against jsdom: it attaches to the given
// document's body, it can never intercept a pointer (pointer-events: none,
// fixed overlay), it follows the pointer with the grabbed point preserved and
// the size capped proportionally, and every exit removes it exactly once.

import { MEDIA_DRAG_GHOST_MAX_PX, mediaDragGhostGeometry } from "./editorMediaDrag";
import { MEDIA_DRAG_GHOST_CLASS, createMediaDragGhost } from "./editorMediaDragGhost";

const RECT = { left: 100, top: 200, width: 800, height: 400 };

function makeGhost(overrides = {}) {
  return createMediaDragGhost({
    doc: document,
    src: "blob:preview-url",
    rect: RECT,
    grabX: 500, // centre of the image
    grabY: 400,
    ...overrides,
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("creation", () => {
  test("the ghost attaches to the body as an inert fixed overlay, hidden until first move", () => {
    const ghost = makeGhost();
    expect(ghost).not.toBeNull();
    expect(ghost.el.parentNode).toBe(document.body);
    expect(ghost.el.className).toBe(MEDIA_DRAG_GHOST_CLASS);
    expect(ghost.el.style.pointerEvents).toBe("none");
    expect(ghost.el.style.position).toBe("fixed");
    expect(ghost.el.getAttribute("aria-hidden")).toBe("true");
    expect(ghost.el.style.visibility).toBe("hidden");
  });

  test("a large image is capped proportionally — aspect ratio preserved by construction", () => {
    const ghost = makeGhost();
    // 800×400 capped at 240 wide → 240×120.
    expect(ghost.el.style.width).toBe(`${MEDIA_DRAG_GHOST_MAX_PX}px`);
    expect(ghost.el.style.height).toBe(`${MEDIA_DRAG_GHOST_MAX_PX / 2}px`);
  });

  test("a small image keeps its real size", () => {
    const ghost = makeGhost({ rect: { left: 0, top: 0, width: 120, height: 90 } });
    expect(ghost.el.style.width).toBe("120px");
    expect(ghost.el.style.height).toBe("90px");
  });

  test("the preview shows the dragged image's own rendered source", () => {
    const ghost = makeGhost();
    const img = ghost.el.querySelector("img");
    expect(img.getAttribute("src")).toBe("blob:preview-url");
    expect(img.draggable).toBe(false);
  });

  test("unusable inputs produce no ghost — a drag with no ghost is still a working drag", () => {
    expect(createMediaDragGhost({})).toBeNull();
    expect(makeGhost({ src: null })).toBeNull();
    expect(makeGhost({ rect: null })).toBeNull();
    expect(makeGhost({ rect: { left: 0, top: 0, width: 0, height: 0 } })).toBeNull();
  });
});

describe("following the pointer", () => {
  test("moveTo places the ghost from the shared geometry — the grabbed point stays under the pointer", () => {
    const ghost = makeGhost();
    ghost.moveTo(600, 500);
    const expected = mediaDragGhostGeometry({
      rect: RECT,
      grabX: 500,
      grabY: 400,
      clientX: 600,
      clientY: 500,
    });
    expect(ghost.el.style.left).toBe(`${expected.left}px`);
    expect(ghost.el.style.top).toBe(`${expected.top}px`);
    expect(ghost.el.style.visibility).toBe("visible");
  });

  test("an unusable point moves nothing rather than misplacing the ghost", () => {
    const ghost = makeGhost();
    ghost.moveTo(600, 500);
    const left = ghost.el.style.left;
    ghost.moveTo(NaN, 500);
    expect(ghost.el.style.left).toBe(left);
  });
});

describe("teardown", () => {
  test("destroy removes the ghost; destroying twice and moving after destroy are safe no-ops", () => {
    const ghost = makeGhost();
    ghost.destroy();
    expect(document.body.querySelector(`.${MEDIA_DRAG_GHOST_CLASS}`)).toBeNull();
    expect(() => ghost.destroy()).not.toThrow();
    expect(() => ghost.moveTo(1, 1)).not.toThrow();
  });
});
