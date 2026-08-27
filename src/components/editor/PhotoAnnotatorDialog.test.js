// The Photo Annotator workspace (src/components/editor/PhotoAnnotatorDialog.js),
// rendered in jsdom with its platform calls injected: the asset store, the
// image decoder and the rasteriser. What is asserted is which asset opens,
// which tools the ribbon offers, dirty state, Save's result and Cancel's
// silence — never pixels. Numbers refer to the P4 brief's test list.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import PhotoAnnotatorDialog from "./PhotoAnnotatorDialog";
import { ASSET_KIND_EDITOR_IMAGE } from "../../lib/assetStorage";
import { PHOTO_SAVE_ACTION, photoAnnotationMetadata } from "../../lib/photoAnnotation";
import { TOOL_LABELS, TOOL } from "../../pdf/pdfTools";
import { clearClipboard } from "../../lib/pdfClipboard";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const W = 800;
const H = 600;
let SCALE = 1;
const ORIGIN = { left: 20, top: 30 };

const realGetRect = Element.prototype.getBoundingClientRect;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
const created = [];
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    if (this.tagName?.toLowerCase() === "svg" && this.closest?.("[data-photo-page]")) {
      return { left: ORIGIN.left, top: ORIGIN.top, width: W * SCALE, height: H * SCALE, right: ORIGIN.left + W * SCALE, bottom: ORIGIN.top + H * SCALE };
    }
    return realGetRect.call(this);
  };
  URL.createObjectURL = (blob) => {
    created.push(blob);
    return `blob:mock-${blob.name || "x"}`;
  };
  URL.revokeObjectURL = jest.fn();
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = realGetRect;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

const blob = (name, type = "image/jpeg") => ({ name, type, size: 100 });
const original = { id: "orig", kind: ASSET_KIND_EDITOR_IMAGE, blob: blob("orig"), metadata: {} };
const items = [{ id: "r1", page: 1, type: "rect", x: 100, y: 100, w: 200, h: 100, stroke: "#333333", strokeWidth: 2 }];
const rendition = {
  id: "rend",
  kind: ASSET_KIND_EDITOR_IMAGE,
  blob: blob("rend"),
  metadata: { annotation: photoAnnotationMetadata({ sourceAssetId: "orig", width: W, height: H, items }) },
};

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

async function mount({ request, assets, render } = {}) {
  SCALE = 1;
  created.length = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const loadAsset = jest.fn(async (id) => assets[id] || null);
  const decode = jest.fn(async () => ({ width: W, height: H, release: jest.fn() }));
  const renderFn = render || jest.fn(async ({ items: layer }) => ({ blob: blob("out"), width: W, height: H, mimeType: "image/jpeg", layerCount: layer.length }));
  const onCancel = jest.fn();
  const onSave = jest.fn(async () => ({ ok: true }));
  await act(async () => {
    root.render(<PhotoAnnotatorDialog request={request} onCancel={onCancel} onSave={onSave} deps={{ loadAsset, decode, render: renderFn }} />);
  });
  // Let the load resolve and the lazily-imported overlay mount.
  for (let i = 0; i < 6; i++) await flush();
  const dialog = host.querySelector("[role=dialog]");
  const svg = () => dialog.querySelector("[data-photo-page] svg");
  const client = (x, y) => ({ clientX: ORIGIN.left + x * SCALE, clientY: ORIGIN.top + y * SCALE });
  const pointer = (type, el, x, y, extra = {}) =>
    act(() => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...client(x, y), ...extra }));
    });
  const button = (label) => dialog.querySelector(`button[aria-label="${label}"]`) || Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent.trim() === label);
  const clickButton = (label) => act(() => button(label).click());
  return {
    host,
    dialog,
    svg,
    pointer,
    button,
    clickButton,
    loadAsset,
    decode,
    render: renderFn,
    onCancel,
    onSave,
    drawRect: async () => {
      clickButton(TOOL_LABELS[TOOL.RECT]);
      pointer("pointerdown", svg(), 100, 100);
      pointer("pointermove", window, 300, 200);
      pointer("pointerup", window, 300, 200);
      await flush();
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

let t;
afterEach(() => {
  t?.unmount();
  t = null;
  clearClipboard();
  jest.restoreAllMocks();
});

describe("3. opening", () => {
  test("a plain photo opens on its own asset, at native size, with Save disabled", async () => {
    t = await mount({ request: { assetId: "orig", annotationSourceId: null, alt: "Wall" }, assets: { orig: original } });
    expect(t.loadAsset).toHaveBeenCalledWith("orig");
    expect(t.dialog.getAttribute("aria-label")).toBe("Annotate photo: Wall");
    expect(t.dialog.getAttribute("data-annotation-editor")).toBe("true");
    expect(created[0]).toBe(original.blob);
    expect(t.dialog.querySelector("img").getAttribute("src")).toBe("blob:mock-orig");
    expect(t.svg().getAttribute("viewBox")).toBe(`0 0 ${W} ${H}`);
    expect(t.button("Save").disabled).toBe(true);
    expect(t.dialog.textContent).toContain(`${W} × ${H} px`);
  });

  test("36. an annotated rendition reopens on the ORIGINAL with its stored layer", async () => {
    t = await mount({ request: { assetId: "rend", annotationSourceId: "orig", alt: "Wall" }, assets: { rend: rendition, orig: original } });
    expect(t.loadAsset.mock.calls.map((c) => c[0])).toEqual(["rend", "orig"]);
    expect(created[0]).toBe(original.blob); // the original's pixels, not the flattened ones
    // The stored rectangle is on the overlay already.
    expect(Array.from(t.svg().querySelectorAll("rect")).some((r) => r.getAttribute("width") === "200")).toBe(true);
    expect(t.button("Save").disabled).toBe(true);
  });

  test("an unavailable asset is reported, not annotated", async () => {
    t = await mount({ request: { assetId: "gone", alt: "x" }, assets: {} });
    expect(t.dialog.querySelector("[role=alert]").textContent).toMatch(/could not be found/);
    expect(t.svg()).toBeNull();
    expect(t.button("Save").disabled).toBe(true);
  });
});

describe("6/20. the ribbon", () => {
  test("offers the image catalogue and no PDF-text tool", async () => {
    t = await mount({ request: { assetId: "orig", alt: "Wall" }, assets: { orig: original } });
    const toolbar = t.dialog.querySelector('[aria-label="Photo annotation tools"]');
    const labels = Array.from(toolbar.querySelectorAll("[data-tool] button")).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Select", "Hand (Pan)", "Text", "Text box", "Callout", "Arrow", "Line", "Rectangle", "Ellipse", "Freehand pen", "Freehand highlight"]);
    for (const absent of ["Edit text", "Highlight", "Underline", "Strikethrough", "Sticky note"]) {
      expect(labels).not.toContain(absent);
    }
    // Undo/Redo/Select all/Delete/zoom are there, honest about their state.
    expect(t.button("Undo").disabled).toBe(true);
    expect(t.button("Delete selected").disabled).toBe(true);
    expect(t.button("Fit photo").disabled).toBe(false);
    expect(t.dialog.querySelector('[aria-label="Annotation options"]')).not.toBeNull();
  });
});

describe("37–39. dirty state, Save and Cancel", () => {
  test("38. drawing enables Save; Save rasterizes the layer over the original and hands over a rendition", async () => {
    t = await mount({ request: { assetId: "orig", alt: "Wall" }, assets: { orig: original } });
    await t.drawRect();
    expect(t.button("Save").disabled).toBe(false);
    expect(t.button("Undo").disabled).toBe(false);
    await act(async () => {
      t.button("Save").click();
    });
    await flush();
    expect(t.render).toHaveBeenCalledTimes(1);
    const arg = t.render.mock.calls[0][0];
    expect(arg.sourceBlob).toBe(original.blob);
    expect(arg.items[0]).toMatchObject({ type: "rect", x: 100, y: 100, w: 200, h: 100 });
    expect(arg.items[0]).not.toHaveProperty("editing");
    expect(t.onSave).toHaveBeenCalledTimes(1);
    expect(t.onSave.mock.calls[0][0]).toMatchObject({ action: PHOTO_SAVE_ACTION.RENDITION, sourceAssetId: "orig", width: W, height: H, mimeType: "image/jpeg" });
    expect(t.onSave.mock.calls[0][0].blob).toEqual(blob("out"));
  });

  test("39. selection and zoom never enable Save", async () => {
    t = await mount({ request: { assetId: "rend", annotationSourceId: "orig", alt: "Wall" }, assets: { rend: rendition, orig: original } });
    act(() => t.dialog.querySelector('[aria-label="Select all annotations"]').click());
    expect(t.button("Delete selected").disabled).toBe(false);
    expect(t.button("Save").disabled).toBe(true);
    const select = t.dialog.querySelector('select[aria-label="Zoom level"]');
    act(() => {
      select.value = "50";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(t.button("Save").disabled).toBe(true);
    expect(t.onSave).not.toHaveBeenCalled();
  });

  test("37. Cancel persists nothing; a dirty Cancel asks first and stays when refused", async () => {
    t = await mount({ request: { assetId: "orig", alt: "Wall" }, assets: { orig: original } });
    t.clickButton("Cancel");
    expect(t.onCancel).toHaveBeenCalledTimes(1);
    await t.drawRect();
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
    t.clickButton("Cancel");
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Discard/));
    expect(t.onCancel).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    t.clickButton("Cancel");
    expect(t.onCancel).toHaveBeenCalledTimes(2);
    expect(t.onSave).not.toHaveBeenCalled();
    expect(t.render).not.toHaveBeenCalled();
  });

  test("removing every annotation from a rendition saves a REVERT to the original, with no rasterization", async () => {
    t = await mount({ request: { assetId: "rend", annotationSourceId: "orig", alt: "Wall" }, assets: { rend: rendition, orig: original } });
    act(() => t.dialog.querySelector('[aria-label="Select all annotations"]').click());
    act(() => t.dialog.querySelector('[aria-label="Delete selected"]').click());
    expect(t.button("Save").disabled).toBe(false);
    await act(async () => {
      t.button("Save").click();
    });
    await flush();
    expect(t.render).not.toHaveBeenCalled();
    expect(t.onSave.mock.calls[0][0]).toMatchObject({ action: PHOTO_SAVE_ACTION.REVERT, sourceAssetId: "orig" });
  });

  test("a failed save is shown in place and the workspace stays open", async () => {
    t = await mount({ request: { assetId: "orig", alt: "Wall" }, assets: { orig: original } });
    t.onSave.mockResolvedValue({ ok: false, error: "Nope." });
    await t.drawRect();
    await act(async () => {
      t.button("Save").click();
    });
    await flush();
    expect(t.dialog.querySelector("[role=alert]").textContent).toContain("Nope.");
    expect(t.onCancel).not.toHaveBeenCalled();
  });

  test("Escape: a creation tool returns to Select, then Select closes (clean) — without touching the note", async () => {
    t = await mount({ request: { assetId: "orig", alt: "Wall" }, assets: { orig: original } });
    t.clickButton(TOOL_LABELS[TOOL.ARROW]);
    const esc = () => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    esc();
    expect(t.button(TOOL_LABELS[TOOL.SELECT]).getAttribute("aria-pressed")).toBe("true");
    expect(t.onCancel).not.toHaveBeenCalled();
    esc();
    expect(t.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("9. zoom is presentation only", () => {
  test("changing the zoom rescales the overlay's CSS size, not its viewBox or the items", async () => {
    t = await mount({ request: { assetId: "rend", annotationSourceId: "orig", alt: "Wall" }, assets: { rend: rendition, orig: original } });
    jest.useFakeTimers();
    const select = t.dialog.querySelector('select[aria-label="Zoom level"]');
    act(() => {
      select.value = "50";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    jest.useRealTimers();
    expect(t.svg().getAttribute("viewBox")).toBe(`0 0 ${W} ${H}`);
    expect(Number(t.svg().getAttribute("width"))).toBe(W / 2);
    expect(t.svg().querySelector('rect[width="200"]')).not.toBeNull();
    expect(t.button("Save").disabled).toBe(true);
  });
});
