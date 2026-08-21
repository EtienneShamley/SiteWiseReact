// src/lib/templateRowHeight.test.js
//
// THE ROW HEIGHT MODEL (Template Editor A2): compact by default, content-driven
// always, and a deliberately dragged height honoured. Pure — no React, no DOM.

import {
  ATTACHMENT_HEAD_MIN_PX,
  COMPACT_ROW_MIN_PX,
  CONTROL_ROW_MIN_PX,
  LEGACY_EVIDENCE_MIN_PX,
  cellMinHeightPx,
  explicitRowHeight,
  explicitRowHeightPatch,
  hasExplicitRowHeight,
  rowDragMinPx,
  rowMinHeightPx,
} from "./templateRowHeight";
import { rowCells } from "./templateColumns";
import { FIELD_TYPE } from "./templateFields";

const row = (over = {}) => ({
  id: "row-1",
  label: "Time",
  px: 120,
  minPx: 100,
  type: FIELD_TYPE.TEXT,
  options: [],
  ...over,
});

/* ================= 14. a one-line row is compact ==================== */

describe("14. a one-line field is a compact row", () => {
  test("the compact floor is one line of document prose plus its cell padding", () => {
    // 20px line box + 8px + 8px (`.twocol-cell-right` is `py-2`).
    expect(COMPACT_ROW_MIN_PX).toBe(36);
    expect(cellMinHeightPx(FIELD_TYPE.TEXT)).toBe(COMPACT_ROW_MIN_PX);
  });

  test("a stored `px` the user never dragged reserves NOTHING", () => {
    expect(rowMinHeightPx({ row: row({ px: 120 }) })).toBe(COMPACT_ROW_MIN_PX);
    expect(rowMinHeightPx({ row: row({ px: 300 }) })).toBe(COMPACT_ROW_MIN_PX);
    // Including the scaffold heights every default template ships with.
    for (const px of [48, 56, 64, 72, 128]) {
      expect(rowMinHeightPx({ row: row({ px }) })).toBe(COMPACT_ROW_MIN_PX);
    }
  });

  test("a row with no height at all is compact, not zero and not broken", () => {
    expect(rowMinHeightPx({ row: { id: "x" } })).toBe(COMPACT_ROW_MIN_PX);
    expect(rowMinHeightPx({})).toBe(COMPACT_ROW_MIN_PX);
    expect(rowMinHeightPx()).toBe(COMPACT_ROW_MIN_PX);
  });
});

/* ================= 15-16. growing with content ====================== */

describe("15-16. the floor is a MINIMUM, never a height", () => {
  test("nothing here can ever cap a row: it returns a floor and only a floor", () => {
    // The contract the callers rely on — `min-height` on a real box, and
    // `resolveBlockHeight`'s max(preferred, measured) in pagination. Wrapped
    // text, a second and third line, a multiline Section and an image all grow
    // the measured height, which is always the larger of the two.
    const floor = rowMinHeightPx({ row: row() });
    expect(floor).toBe(COMPACT_ROW_MIN_PX);
    for (const measured of [36, 56, 80, 400]) {
      expect(Math.max(floor, measured)).toBe(measured >= floor ? measured : floor);
    }
  });

  test("an explicit height raises the floor but never lowers the content one", () => {
    // A user who dragged a row TALLER keeps it tall…
    expect(rowMinHeightPx({ row: row({ px: 300, pxExplicit: true }) })).toBe(300);
    // …and one who dragged it very short still gets a usable row.
    expect(rowMinHeightPx({ row: row({ px: 4, pxExplicit: true }) })).toBe(
      COMPACT_ROW_MIN_PX
    );
  });
});

/* ================= 17-19. structured controls fit =================== */

describe("17-19. structured controls are never clipped", () => {
  test("Date, Time and Select (and every other control type) get the taller floor", () => {
    // 30px control + 8px + 8px cell padding, rounded up for the focus ring.
    expect(CONTROL_ROW_MIN_PX).toBe(48);
    for (const type of [
      FIELD_TYPE.DATE,
      FIELD_TYPE.TIME,
      FIELD_TYPE.SELECT,
      FIELD_TYPE.NUMBER,
      FIELD_TYPE.YESNO,
      FIELD_TYPE.CHECKBOX,
    ]) {
      expect(cellMinHeightPx(type)).toBe(CONTROL_ROW_MIN_PX);
      expect(rowMinHeightPx({ row: row({ type }) })).toBe(CONTROL_ROW_MIN_PX);
    }
  });

  test("the control floor genuinely fits a native date/time input's own button", () => {
    // A native picker button lives INSIDE the 30px input box, so a floor that
    // fits the input fits the button. Guard the arithmetic rather than the
    // rendering, which jsdom cannot lay out.
    const INPUT_BOX_PX = 30; // text-sm (20px line) + py-1 (4+4) + 1px border ×2
    const CELL_PADDING_PX = 16; // py-2
    expect(CONTROL_ROW_MIN_PX).toBeGreaterThanOrEqual(
      INPUT_BOX_PX + CELL_PADDING_PX
    );
  });

  test("a MULTI-COLUMN row is as tall as its TALLEST column needs", () => {
    const cells = [
      { id: "a", type: FIELD_TYPE.TEXT, span: 1 },
      { id: "b", type: FIELD_TYPE.DATE, span: 1 },
    ];
    expect(rowMinHeightPx({ row: row(), cells })).toBe(CONTROL_ROW_MIN_PX);
    // …and a row of one-line fields stays compact.
    expect(
      rowMinHeightPx({
        row: row(),
        cells: cells.map((c) => ({ ...c, type: FIELD_TYPE.TEXT })),
      })
    ).toBe(COMPACT_ROW_MIN_PX);
  });

  test("the cells' types govern, not the row's own stored type", () => {
    const cells = rowCells(
      {
        id: "row-1",
        type: FIELD_TYPE.TEXT,
        cells: [
          { id: "row-1", type: FIELD_TYPE.TEXT, span: 1 },
          { id: "c2", type: FIELD_TYPE.TIME, span: 1 },
        ],
      },
      2
    );
    expect(rowMinHeightPx({ row: row(), cells })).toBe(CONTROL_ROW_MIN_PX);
  });
});

/* ================= legacy surfaces keep their own floors ============ */

describe("the surfaces that had their own floor keep it", () => {
  test("a compound Photo/File head keeps its upload-control height", () => {
    expect(ATTACHMENT_HEAD_MIN_PX).toBe(56);
    expect(
      rowMinHeightPx({ row: row({ type: FIELD_TYPE.PHOTO }), isAttachmentField: true })
    ).toBe(ATTACHMENT_HEAD_MIN_PX);
  });

  test("20. a row rendering the legacy base64 image strip keeps room for it", () => {
    expect(LEGACY_EVIDENCE_MIN_PX).toBe(170);
    expect(rowMinHeightPx({ row: row(), hasLegacyEvidence: true })).toBe(
      LEGACY_EVIDENCE_MIN_PX
    );
    // A deliberately taller row still wins.
    expect(
      rowMinHeightPx({
        row: row({ px: 400, pxExplicit: true }),
        hasLegacyEvidence: true,
      })
    ).toBe(400);
  });
});

/* ================= the explicit-height marker ======================= */

describe("the deliberate-height marker", () => {
  test("only the marker makes a stored height count", () => {
    expect(explicitRowHeight(row({ px: 200 }))).toBe(0);
    expect(hasExplicitRowHeight(row({ px: 200 }))).toBe(false);
    expect(explicitRowHeight(row({ px: 200, pxExplicit: true }))).toBe(200);
    expect(hasExplicitRowHeight(row({ px: 200, pxExplicit: true }))).toBe(true);
  });

  test("a corrupt or hand-edited marker degrades to content-driven sizing", () => {
    for (const px of [0, -5, NaN, "tall", null, undefined]) {
      expect(explicitRowHeight(row({ px, pxExplicit: true }))).toBe(0);
    }
    // A truthy-but-not-true marker is not the marker.
    expect(explicitRowHeight(row({ px: 200, pxExplicit: "yes" }))).toBe(0);
    expect(explicitRowHeight(null)).toBe(0);
  });

  test("a completed drag writes the height AND the marker, floored", () => {
    expect(explicitRowHeightPatch(240)).toEqual({ px: 240, pxExplicit: true });
    expect(explicitRowHeightPatch(2)).toEqual({
      px: COMPACT_ROW_MIN_PX,
      pxExplicit: true,
    });
    expect(explicitRowHeightPatch("nonsense")).toEqual({
      px: COMPACT_ROW_MIN_PX,
      pxExplicit: true,
    });
  });
});

/* ================= the drag floor =================================== */

describe("a row can always be dragged back down to compact", () => {
  test("the drag floor is the CONTENT floor, never the row's current height", () => {
    expect(rowDragMinPx({ row: row({ px: 300, pxExplicit: true }) })).toBe(
      COMPACT_ROW_MIN_PX
    );
    expect(
      rowDragMinPx({ row: row({ type: FIELD_TYPE.DATE, px: 300, pxExplicit: true }) })
    ).toBe(CONTROL_ROW_MIN_PX);
    expect(
      rowDragMinPx({ row: row({ type: FIELD_TYPE.PHOTO }), isAttachmentField: true })
    ).toBe(ATTACHMENT_HEAD_MIN_PX);
  });

  test("the legacy stored `minPx` (100 — nearly three lines) no longer binds it", () => {
    expect(rowDragMinPx({ row: row({ minPx: 100 }) })).toBeLessThan(100);
  });
});
