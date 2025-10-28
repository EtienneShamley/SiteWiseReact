// src/pdf/annotationSchema.js
// Tiny schema + helpers

export const ANN_TYPES = {
  TYPEWRITER: "typewriter",
  TEXTBOX: "textbox",
  CALLOUT: "callout",
  STICKY: "sticky",
  ARROW: "arrow",
  HIGHLIGHT: "highlight",
  UNDERLINE: "underline",
  STRIKE: "strike",
};

export function makeId() {
  return "a_" + Math.random().toString(36).slice(2, 10);
}

// Minimal default style memory per type
export const DEFAULT_STYLE = {
  fill: "rgba(255,255,0,0.25)",
  stroke: "#333333",
  strokeWidth: 2,
  textColor: "#111111",
  fontSize: 14,
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  opacity: 1,
  head: "single", // arrow head: none|single|double
};

export function newAnnotation(type, page, partial = {}) {
  const common = {
    id: makeId(),
    type,
    page,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    locked: false,
    style: { ...DEFAULT_STYLE },
    meta: {},
  };

  switch (type) {
    case ANN_TYPES.TYPEWRITER:
      return { ...common, x: 80, y: 80, text: "Type...", rotate: 0 };
    case ANN_TYPES.TEXTBOX:
      return { ...common, x: 80, y: 80, w: 240, h: 80, text: "Text...", rotate: 0, corner: 8 };
    case ANN_TYPES.CALLOUT:
      return { ...common, x: 200, y: 120, w: 260, h: 90, text: "Callout...", rotate: 0, corner: 8, leader: { x: 160, y: 90 } };
    case ANN_TYPES.STICKY:
      return { ...common, x: 120, y: 120, note: "Note...", color: "#FFE082", open: false };
    case ANN_TYPES.ARROW:
      return { ...common, x1: 120, y1: 120, x2: 260, y2: 160, curved: false };
    case ANN_TYPES.HIGHLIGHT:
    case ANN_TYPES.UNDERLINE:
    case ANN_TYPES.STRIKE:
      return { ...common, x: 80, y: 200, w: 260, h: 24 };
    default:
      return { ...common, ...partial };
  }
}

export function cloneAnn(a) {
  return JSON.parse(JSON.stringify(a));
}
