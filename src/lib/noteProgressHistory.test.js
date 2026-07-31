// Unit tests for the session-only "Save progress" restore-point model
// (src/lib/noteProgressHistory.js).
//
// These cover the guarantees the editing history depends on: the Free-form note
// and Template form histories being genuinely independent, per-note isolation,
// the 20-point cap applying per view, deterministic ordering, lightweight
// capture (references only — never Blob or base64 content), the asset-retention
// rule that stops a Blob being deleted while a restore point still depends on
// it, safe failure when a pinned template version has disappeared, and the fact
// that nothing here touches persistent storage.
import {
  MAX_RESTORE_POINTS,
  NOTE_VIEW,
  NOTE_VIEW_LABEL,
  addRestorePoint,
  captureTemplateFormAttachments,
  collectHistoryAssetIds,
  emptyNoteHistory,
  findRestorePoint,
  getRestorePoints,
  isAssetReferencedByHistory,
  listRestorePointsNewestFirst,
  makeFreeformRestorePoint,
  makeTemplateFormRestorePoint,
  mergeRestoredAttachments,
  pruneDeletedNoteHistories,
  restoreHistoryHeading,
  restorePointAccessibleLabel,
  restorePointTimeLabel,
  validateTemplateFormRestorePoint,
} from "./noteProgressHistory";

// A photo reference exactly as the instance stores it (no binary anywhere).
function photoRef(overrides = {}) {
  return {
    id: "att-1",
    assetId: "asset-1",
    kind: "photo",
    name: "site.png",
    mimeType: "image/png",
    size: 4096,
    createdAt: 1000,
    intrinsicWidth: 1200,
    intrinsicHeight: 800,
    display: { widthPct: 60, alignment: "left" },
    ...overrides,
  };
}

function instance(overrides = {}) {
  return {
    noteId: "note-1",
    templateId: "tpl-1",
    templateVersionId: "ver-1",
    answers: { f_a: "Site A", f_b: "0", f_c: false },
    attachments: { f_photo: [photoRef()] },
    customRows: [
      {
        id: "cr-1",
        templateId: "tpl-1",
        label: "Extra observation",
        type: "text",
        answer: "Cracked kerb",
        preferredHeight: 120,
        placement: { anchorFieldId: "f_b", position: "below" },
        createdAt: 10,
        updatedAt: 20,
      },
    ],
    createdAt: 1,
    ...overrides,
  };
}

// Builds a history containing `count` template-form points for one note.
function withTemplatePoints(historyByNote, noteId, count, makePoint) {
  let next = historyByNote;
  for (let i = 0; i < count; i += 1) next = addRestorePoint(next, noteId, makePoint(i));
  return next;
}

describe("view identity and labels", () => {
  test("the two views are distinct and carry the user-facing names", () => {
    expect(NOTE_VIEW.FREEFORM).not.toBe(NOTE_VIEW.TEMPLATE_FORM);
    expect(NOTE_VIEW_LABEL[NOTE_VIEW.FREEFORM]).toBe("Free-form note");
    expect(NOTE_VIEW_LABEL[NOTE_VIEW.TEMPLATE_FORM]).toBe("Template form");
  });

  test("the dropdown heading names the active view", () => {
    expect(restoreHistoryHeading(NOTE_VIEW.FREEFORM)).toBe("Free-form note restore points");
    expect(restoreHistoryHeading(NOTE_VIEW.TEMPLATE_FORM)).toBe("Template form restore points");
  });

  test("a restore point is labelled by time, never by its raw id", () => {
    const point = makeFreeformRestorePoint({ html: "<p>x</p>", id: "pt-abc", now: 1700000000000 });
    expect(restorePointTimeLabel(point)).not.toContain("pt-abc");
    expect(restorePointTimeLabel(point)).toBe(new Date(1700000000000).toLocaleTimeString());
    expect(restorePointAccessibleLabel(point)).toContain("Free-form note · ");
    expect(restorePointAccessibleLabel(point)).not.toContain("pt-abc");
  });

  test("a missing or nonsense timestamp degrades to readable text", () => {
    expect(restorePointTimeLabel(null)).toBe("Unknown time");
    expect(restorePointTimeLabel({ ts: "nope" })).toBe("Unknown time");
  });
});

describe("independent Free-form and Template form histories", () => {
  test("saving in one view leaves the other view's history untouched", () => {
    let h = {};
    h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ html: "<p>a</p>" }));
    h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ html: "<p>b</p>" }));
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM)).toHaveLength(2);
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.TEMPLATE_FORM)).toHaveLength(0);

    h = addRestorePoint(h, "note-1", makeTemplateFormRestorePoint({ instance: instance() }));
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM)).toHaveLength(2);
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.TEMPLATE_FORM)).toHaveLength(1);
  });

  test("a point is filed under its OWN view, never the one the caller assumed", () => {
    const templatePoint = makeTemplateFormRestorePoint({ instance: instance() });
    const h = addRestorePoint({}, "note-1", templatePoint);
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM)).toEqual([]);
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.TEMPLATE_FORM)).toEqual([templatePoint]);
  });

  test("switching views selects that view's history and nothing else", () => {
    let h = {};
    h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ html: "<p>free</p>" }));
    h = addRestorePoint(h, "note-1", makeTemplateFormRestorePoint({ instance: instance() }));

    const freeform = getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM);
    const templateForm = getRestorePoints(h, "note-1", NOTE_VIEW.TEMPLATE_FORM);
    expect(freeform.every((p) => p.view === NOTE_VIEW.FREEFORM)).toBe(true);
    expect(templateForm.every((p) => p.view === NOTE_VIEW.TEMPLATE_FORM)).toBe(true);
    expect(freeform[0].html).toBe("<p>free</p>");
    expect(templateForm[0].html).toBeUndefined();
  });

  test("a Free-form point carries no Template form state, and vice versa", () => {
    const free = makeFreeformRestorePoint({ html: "<p>a</p>" });
    expect(free.answers).toBeUndefined();
    expect(free.customRows).toBeUndefined();
    expect(free.attachments).toBeUndefined();
    expect(free.templateId).toBeUndefined();

    const tpl = makeTemplateFormRestorePoint({ instance: instance() });
    expect(tpl.html).toBeUndefined();
  });

  test("a Free-form point cannot be found through the Template form history", () => {
    const point = makeFreeformRestorePoint({ html: "<p>a</p>", id: "pt-1" });
    const h = addRestorePoint({}, "note-1", point);
    expect(findRestorePoint(h, "note-1", NOTE_VIEW.FREEFORM, "pt-1")).toBe(point);
    expect(findRestorePoint(h, "note-1", NOTE_VIEW.TEMPLATE_FORM, "pt-1")).toBeNull();
  });
});

describe("per-note isolation", () => {
  test("each note keeps its own histories and sees nothing of another note's", () => {
    let h = {};
    h = addRestorePoint(h, "note-A", makeFreeformRestorePoint({ html: "<p>A</p>", id: "a1" }));
    h = addRestorePoint(h, "note-B", makeFreeformRestorePoint({ html: "<p>B</p>", id: "b1" }));

    expect(getRestorePoints(h, "note-A", NOTE_VIEW.FREEFORM).map((p) => p.id)).toEqual(["a1"]);
    expect(getRestorePoints(h, "note-B", NOTE_VIEW.FREEFORM).map((p) => p.id)).toEqual(["b1"]);
    expect(findRestorePoint(h, "note-B", NOTE_VIEW.FREEFORM, "a1")).toBeNull();
  });

  test("an unknown note has empty histories rather than throwing", () => {
    expect(getRestorePoints({}, "never-opened", NOTE_VIEW.FREEFORM)).toEqual([]);
    expect(getRestorePoints(undefined, undefined, undefined)).toEqual([]);
    expect(listRestorePointsNewestFirst({}, "never-opened", NOTE_VIEW.TEMPLATE_FORM)).toEqual([]);
  });

  test("attachment references stay isolated by note AND by view", () => {
    let h = {};
    h = addRestorePoint(
      h,
      "note-A",
      makeTemplateFormRestorePoint({
        instance: instance({ attachments: { f: [photoRef({ assetId: "asset-A" })] } }),
      })
    );
    h = addRestorePoint(
      h,
      "note-B",
      makeTemplateFormRestorePoint({
        instance: instance({ attachments: { f: [photoRef({ assetId: "asset-B" })] } }),
      })
    );
    // A Free-form point never contributes attachment references at all.
    h = addRestorePoint(h, "note-A", makeFreeformRestorePoint({ html: "<p>a</p>" }));

    const aPoint = getRestorePoints(h, "note-A", NOTE_VIEW.TEMPLATE_FORM)[0];
    const bPoint = getRestorePoints(h, "note-B", NOTE_VIEW.TEMPLATE_FORM)[0];
    expect(aPoint.attachments.f[0].assetId).toBe("asset-A");
    expect(bPoint.attachments.f[0].assetId).toBe("asset-B");
    expect(collectHistoryAssetIds({ "note-A": h["note-A"] })).toEqual(new Set(["asset-A"]));
    expect(collectHistoryAssetIds({ "note-B": h["note-B"] })).toEqual(new Set(["asset-B"]));
  });
});

describe("the 20-point limit", () => {
  test("the cap is 20 and applies per view, per note", () => {
    expect(MAX_RESTORE_POINTS).toBe(20);
  });

  test("the newest 20 are retained and the oldest is discarded", () => {
    let h = {};
    for (let i = 0; i < 25; i += 1) {
      h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ html: `<p>${i}</p>`, id: `pt-${i}` }));
    }
    const points = getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM);
    expect(points).toHaveLength(20);
    expect(points[0].id).toBe("pt-5");
    expect(points[19].id).toBe("pt-24");
    expect(findRestorePoint(h, "note-1", NOTE_VIEW.FREEFORM, "pt-4")).toBeNull();
  });

  test("nothing is discarded before the limit is exceeded", () => {
    let h = {};
    for (let i = 0; i < MAX_RESTORE_POINTS; i += 1) {
      h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ id: `pt-${i}` }));
    }
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM)).toHaveLength(20);
    expect(findRestorePoint(h, "note-1", NOTE_VIEW.FREEFORM, "pt-0")).not.toBeNull();
  });

  test("each view is capped independently — one filling up never evicts the other", () => {
    let h = {};
    for (let i = 0; i < 25; i += 1) {
      h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ id: `free-${i}` }));
    }
    for (let i = 0; i < 3; i += 1) {
      h = addRestorePoint(h, "note-1", makeTemplateFormRestorePoint({ instance: instance(), id: `tpl-${i}` }));
    }
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM)).toHaveLength(20);
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.TEMPLATE_FORM)).toHaveLength(3);

    for (let i = 3; i < 25; i += 1) {
      h = addRestorePoint(h, "note-1", makeTemplateFormRestorePoint({ instance: instance(), id: `tpl-${i}` }));
    }
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.TEMPLATE_FORM)).toHaveLength(20);
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM)).toHaveLength(20);
  });

  test("each note is capped independently", () => {
    let h = {};
    for (let i = 0; i < 25; i += 1) {
      h = addRestorePoint(h, "note-A", makeFreeformRestorePoint({ id: `a-${i}` }));
    }
    h = addRestorePoint(h, "note-B", makeFreeformRestorePoint({ id: "b-0" }));
    expect(getRestorePoints(h, "note-A", NOTE_VIEW.FREEFORM)).toHaveLength(20);
    expect(getRestorePoints(h, "note-B", NOTE_VIEW.FREEFORM)).toHaveLength(1);
  });
});

describe("ordering", () => {
  test("stored order is creation order; display order is newest first", () => {
    let h = {};
    h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ id: "p1", now: 100 }));
    h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ id: "p2", now: 200 }));
    h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ id: "p3", now: 300 }));

    expect(getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM).map((p) => p.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    expect(
      listRestorePointsNewestFirst(h, "note-1", NOTE_VIEW.FREEFORM).map((p) => p.id)
    ).toEqual(["p3", "p2", "p1"]);
  });

  test("points sharing one millisecond keep a deterministic order (array, not timestamp)", () => {
    let h = {};
    h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ id: "p1", now: 500 }));
    h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ id: "p2", now: 500 }));
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM).map((p) => p.id)).toEqual([
      "p1",
      "p2",
    ]);
    expect(
      listRestorePointsNewestFirst(h, "note-1", NOTE_VIEW.FREEFORM).map((p) => p.id)
    ).toEqual(["p2", "p1"]);
  });

  test("reading for display never mutates the stored list", () => {
    const h = addRestorePoint({}, "note-1", makeFreeformRestorePoint({ id: "p1" }));
    const before = getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM);
    listRestorePointsNewestFirst(h, "note-1", NOTE_VIEW.FREEFORM).reverse();
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.FREEFORM)).toEqual(before);
  });

  test("each point gets a unique id even when created in the same millisecond", () => {
    const a = makeFreeformRestorePoint({ now: 1 });
    const b = makeFreeformRestorePoint({ now: 1 });
    expect(a.id).not.toBe(b.id);
  });
});

describe("what a Template form point captures", () => {
  test("captures the exact template and version pinned at that moment", () => {
    const point = makeTemplateFormRestorePoint({
      instance: instance({ templateId: "tpl-9", templateVersionId: "ver-9" }),
    });
    expect(point.templateId).toBe("tpl-9");
    expect(point.templateVersionId).toBe("ver-9");
  });

  test("captures answers, custom rows (label, answer, placement, height) and photo display metadata", () => {
    const point = makeTemplateFormRestorePoint({ instance: instance() });
    expect(point.answers).toEqual({ f_a: "Site A", f_b: "0", f_c: false });
    expect(point.customRows[0]).toMatchObject({
      id: "cr-1",
      label: "Extra observation",
      answer: "Cracked kerb",
      preferredHeight: 120,
      placement: { anchorFieldId: "f_b", position: "below" },
    });
    expect(point.attachments.f_photo[0].display).toEqual({ widthPct: 60, alignment: "left" });
  });

  test("later edits to the live instance cannot reach back into a captured point", () => {
    const inst = instance();
    const point = makeTemplateFormRestorePoint({ instance: inst });

    inst.answers.f_a = "changed";
    inst.customRows[0].label = "changed";
    inst.customRows[0].placement.position = "above";
    inst.attachments.f_photo.push(photoRef({ id: "att-2", assetId: "asset-2" }));

    expect(point.answers.f_a).toBe("Site A");
    expect(point.customRows[0].label).toBe("Extra observation");
    expect(point.customRows[0].placement.position).toBe("below");
    expect(point.attachments.f_photo).toHaveLength(1);
  });

  test("returns null when there is no instance to capture", () => {
    expect(makeTemplateFormRestorePoint({ instance: null })).toBeNull();
    expect(makeTemplateFormRestorePoint({})).toBeNull();
  });

  test("a note with no template assigned captures safely", () => {
    const point = makeTemplateFormRestorePoint({
      instance: { noteId: "n", templateId: null, templateVersionId: null },
    });
    expect(point.templateId).toBeNull();
    expect(point.templateVersionId).toBeNull();
    expect(point.answers).toEqual({});
    expect(point.customRows).toEqual([]);
    expect(point.attachments).toEqual({});
  });
});

describe("attachments are references only — no Blob, no base64", () => {
  test("only the known reference properties survive capture", () => {
    const point = makeTemplateFormRestorePoint({ instance: instance() });
    expect(Object.keys(point.attachments.f_photo[0]).sort()).toEqual(
      [
        "assetId",
        "createdAt",
        "display",
        "id",
        "intrinsicHeight",
        "intrinsicWidth",
        "kind",
        "mimeType",
        "name",
        "size",
      ].sort()
    );
  });

  test("a Blob, a data URL or an object URL smuggled onto a reference is dropped", () => {
    const point = makeTemplateFormRestorePoint({
      instance: instance({
        attachments: {
          f: [
            photoRef({
              blob: { size: 999 },
              dataUrl: "data:image/png;base64,AAAA",
              objectUrl: "blob:http://localhost/abc",
              base64: "AAAA",
            }),
          ],
        },
      }),
    });
    const captured = point.attachments.f[0];
    expect(captured.blob).toBeUndefined();
    expect(captured.dataUrl).toBeUndefined();
    expect(captured.objectUrl).toBeUndefined();
    expect(captured.base64).toBeUndefined();

    const serialized = JSON.stringify(point);
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("blob:");
    expect(serialized).not.toContain("base64");
  });

  test("a field still holding LEGACY base64 strings is not captured and is reported instead", () => {
    const { attachments, uncapturedFieldIds } = captureTemplateFormAttachments({
      f_legacy: ["data:image/png;base64,AAAA"],
      f_modern: [photoRef()],
    });
    expect(uncapturedFieldIds).toEqual(["f_legacy"]);
    expect(attachments.f_legacy).toBeUndefined();
    expect(attachments.f_modern).toHaveLength(1);
    expect(JSON.stringify(attachments)).not.toContain("base64");
  });

  test("restoring leaves an uncaptured legacy field exactly as it is stored", () => {
    const point = makeTemplateFormRestorePoint({
      instance: instance({
        attachments: { f_legacy: ["data:image/png;base64,AAAA"], f_modern: [photoRef()] },
      }),
    });
    const currentMap = {
      f_legacy: ["data:image/png;base64,AAAA"],
      f_modern: [photoRef(), photoRef({ id: "att-2", assetId: "asset-2" })],
    };
    const merged = mergeRestoredAttachments(currentMap, point);
    // The legacy evidence is neither copied into history nor destroyed by the restore.
    expect(merged.f_legacy).toBe(currentMap.f_legacy);
    // The captured field is restored to its captured contents.
    expect(merged.f_modern).toHaveLength(1);
    expect(merged.f_modern[0].assetId).toBe("asset-1");
  });

  test("a field added after the point was taken is dropped from the restored map", () => {
    const point = makeTemplateFormRestorePoint({ instance: instance() });
    const merged = mergeRestoredAttachments(
      { f_photo: [photoRef()], f_added_later: [photoRef({ assetId: "asset-later" })] },
      point
    );
    expect(merged.f_added_later).toBeUndefined();
    expect(merged.f_photo).toHaveLength(1);
  });

  test("the restored map is a copy — mutating it cannot corrupt the restore point", () => {
    const point = makeTemplateFormRestorePoint({ instance: instance() });
    const merged = mergeRestoredAttachments({}, point);
    merged.f_photo[0].display.widthPct = 100;
    merged.f_photo.push(photoRef({ id: "att-x", assetId: "asset-x" }));
    expect(point.attachments.f_photo).toHaveLength(1);
    expect(point.attachments.f_photo[0].display.widthPct).toBe(60);
  });
});

describe("asset retention while a restore point depends on an asset", () => {
  test("an asset referenced by a restore point is reported as still needed", () => {
    const h = addRestorePoint({}, "note-1", makeTemplateFormRestorePoint({ instance: instance() }));
    expect(isAssetReferencedByHistory(h, "asset-1")).toBe(true);
    expect(isAssetReferencedByHistory(h, "asset-never-used")).toBe(false);
    expect(isAssetReferencedByHistory(h, null)).toBe(false);
  });

  test("removing the attachment from the CURRENT form leaves the history reference intact", () => {
    // 1. Save a restore point containing Photo A.
    const h = addRestorePoint({}, "note-1", makeTemplateFormRestorePoint({ instance: instance() }));
    // 2. Photo A is removed from the live form — the current instance no longer
    //    references it, so the ordinary reference check would allow deletion.
    const currentInstanceHasIt = false;
    // 3. The restore point still depends on it, so the Blob must be kept.
    expect(currentInstanceHasIt || isAssetReferencedByHistory(h, "asset-1")).toBe(true);
    // 4. Restoring that point recovers a reference to the surviving asset.
    const point = getRestorePoints(h, "note-1", NOTE_VIEW.TEMPLATE_FORM)[0];
    const restored = mergeRestoredAttachments({}, point);
    expect(restored.f_photo[0].assetId).toBe("asset-1");
  });

  test("evicting the oldest point at the 20-point limit releases its asset reference", () => {
    let h = withTemplatePoints({}, "note-1", 1, () =>
      makeTemplateFormRestorePoint({
        instance: instance({ attachments: { f: [photoRef({ assetId: "asset-oldest" })] } }),
      })
    );
    expect(isAssetReferencedByHistory(h, "asset-oldest")).toBe(true);

    // 20 further points push the first one out of the capped list.
    h = withTemplatePoints(h, "note-1", MAX_RESTORE_POINTS, (i) =>
      makeTemplateFormRestorePoint({
        instance: instance({ attachments: { f: [photoRef({ assetId: `asset-${i}` })] } }),
      })
    );
    expect(getRestorePoints(h, "note-1", NOTE_VIEW.TEMPLATE_FORM)).toHaveLength(20);
    expect(isAssetReferencedByHistory(h, "asset-oldest")).toBe(false);
    expect(isAssetReferencedByHistory(h, "asset-19")).toBe(true);
  });

  test("deleting a note's history releases the assets only that note's points held", () => {
    let h = {};
    h = addRestorePoint(
      h,
      "note-A",
      makeTemplateFormRestorePoint({
        instance: instance({ attachments: { f: [photoRef({ assetId: "asset-A" })] } }),
      })
    );
    h = addRestorePoint(
      h,
      "note-B",
      makeTemplateFormRestorePoint({
        instance: instance({ attachments: { f: [photoRef({ assetId: "asset-B" })] } }),
      })
    );
    const pruned = pruneDeletedNoteHistories(h, new Set(["note-B"]));
    expect(isAssetReferencedByHistory(pruned, "asset-A")).toBe(false);
    expect(isAssetReferencedByHistory(pruned, "asset-B")).toBe(true);
  });

  test("collecting asset ids ignores Free-form points and malformed entries", () => {
    let h = addRestorePoint({}, "note-1", makeFreeformRestorePoint({ html: "<p>a</p>" }));
    expect(collectHistoryAssetIds(h)).toEqual(new Set());

    h = {
      "note-1": {
        [NOTE_VIEW.TEMPLATE_FORM]: [
          { view: NOTE_VIEW.TEMPLATE_FORM, attachments: null },
          { view: NOTE_VIEW.TEMPLATE_FORM, attachments: { f: "not-an-array" } },
          { view: NOTE_VIEW.TEMPLATE_FORM, attachments: { f: [{ assetId: "" }, {}, null] } },
        ],
      },
    };
    expect(collectHistoryAssetIds(h)).toEqual(new Set());
    expect(collectHistoryAssetIds(undefined)).toEqual(new Set());
  });
});

describe("restoring a point whose template version has gone", () => {
  const versionExists = (id) => id === "ver-1";

  test("a resolvable version validates", () => {
    const point = makeTemplateFormRestorePoint({ instance: instance() });
    expect(validateTemplateFormRestorePoint(point, { versionExists })).toEqual({ ok: true });
  });

  test("an unresolvable version fails WHOLE with a readable message", () => {
    const point = makeTemplateFormRestorePoint({
      instance: instance({ templateVersionId: "ver-deleted" }),
    });
    const result = validateTemplateFormRestorePoint(point, { versionExists });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no longer available/i);
    expect(result.error).toMatch(/nothing was changed/i);
  });

  test("a point that pinned no version at all is restorable", () => {
    const point = makeTemplateFormRestorePoint({
      instance: { noteId: "n", templateId: null, templateVersionId: null },
    });
    expect(validateTemplateFormRestorePoint(point, { versionExists }).ok).toBe(true);
  });

  test("a Free-form point is never accepted by the Template form restore path", () => {
    const point = makeFreeformRestorePoint({ html: "<p>a</p>" });
    expect(validateTemplateFormRestorePoint(point, { versionExists }).ok).toBe(false);
    expect(validateTemplateFormRestorePoint(null, { versionExists }).ok).toBe(false);
  });
});

describe("deleted-note history cleanup", () => {
  test("histories of notes that no longer exist are dropped", () => {
    let h = {};
    h = addRestorePoint(h, "note-A", makeFreeformRestorePoint({ id: "a1" }));
    h = addRestorePoint(h, "note-B", makeFreeformRestorePoint({ id: "b1" }));
    h = addRestorePoint(h, "note-C", makeFreeformRestorePoint({ id: "c1" }));

    const pruned = pruneDeletedNoteHistories(h, new Set(["note-A", "note-C"]));
    expect(Object.keys(pruned).sort()).toEqual(["note-A", "note-C"]);
    expect(getRestorePoints(pruned, "note-A", NOTE_VIEW.FREEFORM)).toHaveLength(1);
  });

  test("deleting every note clears every history", () => {
    const h = addRestorePoint({}, "note-A", makeFreeformRestorePoint({ id: "a1" }));
    expect(pruneDeletedNoteHistories(h, new Set())).toEqual({});
  });

  test("returns the SAME reference when nothing needs removing (no render loop)", () => {
    const h = addRestorePoint({}, "note-A", makeFreeformRestorePoint({ id: "a1" }));
    expect(pruneDeletedNoteHistories(h, new Set(["note-A", "note-B"]))).toBe(h);
    expect(pruneDeletedNoteHistories({}, new Set())).toEqual({});
  });

  test("accepts an array of live ids as well as a Set", () => {
    const h = addRestorePoint({}, "note-A", makeFreeformRestorePoint({ id: "a1" }));
    expect(Object.keys(pruneDeletedNoteHistories(h, ["note-A"]))).toEqual(["note-A"]);
    expect(Object.keys(pruneDeletedNoteHistories(h, ["note-Z"]))).toEqual([]);
  });
});

describe("history is session-only and never persisted", () => {
  test("building and capping a history writes nothing to localStorage", () => {
    localStorage.clear();
    let h = {};
    for (let i = 0; i < 25; i += 1) {
      h = addRestorePoint(h, "note-1", makeFreeformRestorePoint({ html: `<p>${i}</p>` }));
      h = addRestorePoint(h, "note-1", makeTemplateFormRestorePoint({ instance: instance() }));
    }
    h = pruneDeletedNoteHistories(h, new Set(["note-1"]));
    mergeRestoredAttachments({}, getRestorePoints(h, "note-1", NOTE_VIEW.TEMPLATE_FORM)[0]);
    collectHistoryAssetIds(h);

    expect(localStorage.length).toBe(0);
  });

  test("no module export writes a restore point to storage on import or use", () => {
    localStorage.clear();
    const point = makeTemplateFormRestorePoint({ instance: instance() });
    expect(localStorage.getItem("sitewise-note-template-instances-v1")).toBeNull();
    expect(point.id).toBeTruthy();
    expect(localStorage.length).toBe(0);
  });
});

describe("defensive input handling", () => {
  test("an empty note history has both views", () => {
    expect(emptyNoteHistory()).toEqual({ freeform: [], templateForm: [] });
  });

  test("a missing note id, point, or unknown view leaves the history unchanged", () => {
    const h = addRestorePoint({}, "note-1", makeFreeformRestorePoint({ id: "p1" }));
    expect(addRestorePoint(h, null, makeFreeformRestorePoint({}))).toBe(h);
    expect(addRestorePoint(h, "note-1", null)).toBe(h);
    expect(addRestorePoint(h, "note-1", { view: "sideways" })).toBe(h);
  });

  test("adding to a note that already has one view initialised keeps the other", () => {
    let h = addRestorePoint({}, "note-1", makeFreeformRestorePoint({ id: "p1" }));
    h = addRestorePoint(h, "note-1", makeTemplateFormRestorePoint({ instance: instance(), id: "t1" }));
    expect(Object.keys(h["note-1"]).sort()).toEqual(["freeform", "templateForm"]);
  });
});
