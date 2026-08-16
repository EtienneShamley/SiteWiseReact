// src/components/editor/mediaImagePresentation.test.js
//
// The one PURE piece of the shared media image presentation:
// mediaImageWrapperClassNames — the wrapper class-list derivation both a live
// NodeView and a future static Section view build from.
//
// `useMediaImagePresentation` is a React hook that resolves an asset (via
// useAssetObjectUrl) and returns JSX; it cannot be exercised without a DOM
// rendering library, which this project deliberately does not install (see
// docs/TESTING.md). Its correctness is verified instead by:
//   - this file's coverage of the one pure helper it also exports;
//   - the source-text boundary assertions in editorMediaCore.test.js proving
//     AssetImage.js consumes this module rather than growing a private copy;
//   - the unchanged behaviour of every downstream suite that depends on what
//     AssetImage.js renders (exportImageAssets, freeformExportPdfHtml, the
//     resize/drag/placement suites), all still green after this extraction.
import { mediaImageWrapperClassNames } from "./mediaImagePresentation";
import { MEDIA_CLASS } from "../../lib/editorMediaLayout";

describe("mediaImageWrapperClassNames", () => {
  test("18. block layout, unsized, no extras — the byte-identical legacy default", () => {
    expect(mediaImageWrapperClassNames({ layoutMode: "block", layoutSide: null })).toBe(
      "note-image-node nw-media nw-media--block"
    );
  });

  test("18. wrap-left / wrap-right classes derive through the ONE shared layout authority", () => {
    expect(
      mediaImageWrapperClassNames({ layoutMode: "wrap", layoutSide: "left" })
    ).toBe("note-image-node nw-media nw-media--wrap nw-media--wrap-left");
    expect(
      mediaImageWrapperClassNames({ layoutMode: "wrap", layoutSide: "right" })
    ).toBe("note-image-node nw-media nw-media--wrap nw-media--wrap-right");
  });

  test("17. widthPct presentation — the sized class appears only when sized is true", () => {
    expect(
      mediaImageWrapperClassNames({ layoutMode: "block", layoutSide: null, sized: true })
    ).toBe(`note-image-node ${MEDIA_CLASS} ${MEDIA_CLASS}--block ${MEDIA_CLASS}--sized`);
    expect(
      mediaImageWrapperClassNames({ layoutMode: "block", layoutSide: null, sized: false })
    ).not.toContain("--sized");
  });

  test("extra (interaction-only) classes append in the given order, after the shared ones", () => {
    const out = mediaImageWrapperClassNames({
      layoutMode: "block",
      layoutSide: null,
      sized: true,
      extra: [`${MEDIA_CLASS}--selected`, `${MEDIA_CLASS}--resizing`, `${MEDIA_CLASS}--dragging`],
    });
    expect(out).toBe(
      `note-image-node ${MEDIA_CLASS} ${MEDIA_CLASS}--block ${MEDIA_CLASS}--sized ` +
        `${MEDIA_CLASS}--selected ${MEDIA_CLASS}--resizing ${MEDIA_CLASS}--dragging`
    );
  });

  test("falsy extras are dropped, exactly as the live NodeView's own filter always did", () => {
    const out = mediaImageWrapperClassNames({
      layoutMode: "block",
      layoutSide: null,
      extra: ["", false, null, undefined, `${MEDIA_CLASS}--dragging`],
    });
    expect(out).toBe(`note-image-node ${MEDIA_CLASS} ${MEDIA_CLASS}--block ${MEDIA_CLASS}--dragging`);
  });

  test("an unknown/missing layout normalizes to block, exactly like every other consumer", () => {
    expect(mediaImageWrapperClassNames({})).toBe("note-image-node nw-media nw-media--block");
    expect(mediaImageWrapperClassNames()).toBe("note-image-node nw-media nw-media--block");
    expect(
      mediaImageWrapperClassNames({ layoutMode: "wrap", layoutSide: "up" })
    ).toBe("note-image-node nw-media nw-media--block");
  });

  test("a non-array extra is tolerated rather than throwing", () => {
    expect(
      mediaImageWrapperClassNames({ layoutMode: "block", layoutSide: null, extra: "not-an-array" })
    ).toBe("note-image-node nw-media nw-media--block");
  });
});
