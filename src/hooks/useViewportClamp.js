// src/hooks/useViewportClamp.js
//
// KEEP AN ANCHORED POPOVER INSIDE THE VIEWPORT (Phase 8E.1 polish).
//
// The document header's Refine and Export panels and the toolbar's table menu
// are positioned by CSS beside their trigger (`absolute right-0` / `left-0`).
// That is correct wherever the trigger has room — which is always the case on
// a desktop — but on a phone the trigger can sit near a screen edge, and a
// 19rem panel anchored to its right edge then opens partly off-screen.
//
// This hook leaves the CSS positioning exactly as it is and only corrects it
// when the rendered panel actually crosses an edge: it narrows a panel wider
// than the viewport, then shifts it inward by the overflow. A panel that
// already fits is not touched at all, so desktop placement is unchanged.
//
// Both the panel rect and the viewport width are read in the same (client)
// coordinate space, so no offset is hard-coded and no zoom is assumed: the
// panels this is used for live in the application chrome, outside the zoomed
// document.
import { useLayoutEffect } from "react";

/** The gap a clamped popover keeps from the screen edge. */
export const VIEWPORT_EDGE_MARGIN_PX = 8;

/**
 * How far (px) to move a box horizontally so it sits inside
 * [margin, viewportWidth - margin]. Negative moves left, positive right, 0
 * when it already fits. A box wider than the space is aligned to the left
 * margin (its content starts on screen) — callers narrow it first.
 */
export function viewportClampOffset({ left, right, viewportWidth, margin = VIEWPORT_EDGE_MARGIN_PX } = {}) {
  if (![left, right, viewportWidth].every(Number.isFinite) || viewportWidth <= 0) return 0;
  if (left < margin) return margin - left;
  if (right > viewportWidth - margin) {
    return Math.max(margin - left, viewportWidth - margin - right);
  }
  return 0;
}

function viewportWidthNow() {
  if (typeof window === "undefined") return 0;
  const doc = typeof document !== "undefined" ? document.documentElement : null;
  return (doc && doc.clientWidth) || window.innerWidth || 0;
}

/**
 * Clamp the element in `ref` into the viewport while `active`. Re-applies on
 * resize and orientation change; clears everything it set when it stops.
 */
export default function useViewportClamp(ref, active) {
  useLayoutEffect(() => {
    if (!active) return undefined;
    const el = ref.current;
    if (!el || typeof el.getBoundingClientRect !== "function") return undefined;

    const reset = () => {
      el.style.transform = "";
      el.style.maxWidth = "";
      el.style.minWidth = "";
    };
    const apply = () => {
      reset();
      const viewportWidth = viewportWidthNow();
      if (!viewportWidth) return;
      const available = viewportWidth - 2 * VIEWPORT_EDGE_MARGIN_PX;
      let rect = el.getBoundingClientRect();
      if (!rect || !(rect.width > 0)) return;
      if (rect.width > available) {
        el.style.minWidth = "0px";
        el.style.maxWidth = `${available}px`;
        rect = el.getBoundingClientRect();
      }
      const dx = viewportClampOffset({ left: rect.left, right: rect.right, viewportWidth });
      if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
    };

    apply();
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    const vv = window.visualViewport;
    if (vv && typeof vv.addEventListener === "function") vv.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      if (vv && typeof vv.removeEventListener === "function") vv.removeEventListener("resize", apply);
      reset();
    };
  }, [ref, active]);
}
