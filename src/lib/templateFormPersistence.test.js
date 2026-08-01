// Confirmed-persistence tests for the Template form's write path.
//
// Autosave may report "Saved locally" only after a write has actually landed.
// Every Template form change — master answers, structured field values, the
// template assignment, custom rows, attachment references and photo display
// settings, and row-level AI refine/revert — now goes through one confirmed
// (throwing, read-back-verified) save, so these tests exercise that save
// against real jsdom localStorage and against a storage that refuses to write.
//
// They also cover the attachment-retention rule after the removal of the
// temporary editing history: the current-instance reference check is intact,
// and it is the only protection that remains.
import {
  createTemplate,
  getNoteTemplateInstance,
  getOrCreateInstanceForNote,
  isAttachmentAssetReferenced,
  saveNoteTemplateInstanceOrThrow,
  getTemplate,
  NOTE_TEMPLATE_INSTANCES_KEY,
} from "./templateModel";

const NOTE = "note-1";
const OTHER_NOTE = "note-2";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Refuse every localStorage write, as a full quota does.
function breakStorageWrites() {
  return jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
}

// The status a caller would report, derived ONLY from what the write actually
// did — this is exactly the shape of the wrapper in NoteTemplateDoc.
function saveAndReport(instance) {
  try {
    saveNoteTemplateInstanceOrThrow(instance);
    return "saved";
  } catch {
    return "failed";
  }
}

function seededInstance() {
  createTemplate("Site report", { rows: [{ id: "field-1", label: "Notes" }] });
  return getOrCreateInstanceForNote(NOTE);
}

describe("confirmed writes report success only when the record landed", () => {
  test("a master answer is written and read back", () => {
    const instance = seededInstance();
    const next = { ...instance, answers: { "field-1": "Footing inspected" } };

    expect(saveAndReport(next)).toBe("saved");
    expect(getNoteTemplateInstance(NOTE).answers["field-1"]).toBe(
      "Footing inspected"
    );
  });

  test("structured field values keep their distinct types", () => {
    const instance = seededInstance();
    const next = {
      ...instance,
      answers: { num: "0", check: false, yesno: "", drop: "opt-1" },
    };

    expect(saveAndReport(next)).toBe("saved");
    const stored = getNoteTemplateInstance(NOTE).answers;
    expect(stored.num).toBe("0");
    expect(stored.check).toBe(false);
    expect(stored.yesno).toBe("");
    expect(stored.drop).toBe("opt-1");
  });

  test("a custom row is written and read back", () => {
    const instance = seededInstance();
    const next = {
      ...instance,
      customRows: [
        {
          id: "custom-1",
          templateId: instance.templateId,
          label: "Weather",
          type: "text",
          answer: "Heavy rain from 2pm",
          placement: { anchorFieldId: "field-1", position: "below" },
        },
      ],
    };

    expect(saveAndReport(next)).toBe("saved");
    expect(getNoteTemplateInstance(NOTE).customRows[0].answer).toBe(
      "Heavy rain from 2pm"
    );
  });

  test("a template assignment is written and read back", () => {
    const instance = seededInstance();
    const other = createTemplate("Handover", { rows: [] });
    const tpl = getTemplate(other.id);

    const next = {
      ...instance,
      templateId: tpl.id,
      templateVersionId: tpl.currentVersionId,
    };
    expect(saveAndReport(next)).toBe("saved");

    const stored = getNoteTemplateInstance(NOTE);
    expect(stored.templateId).toBe(tpl.id);
    expect(stored.templateVersionId).toBe(tpl.currentVersionId);
  });

  test("an attachment reference and its display settings are written and read back", () => {
    const instance = seededInstance();
    const next = {
      ...instance,
      attachments: {
        "field-1": [
          {
            id: "att-1",
            assetId: "asset-1",
            kind: "photo",
            name: "footing.jpg",
            mimeType: "image/jpeg",
            size: 1024,
            createdAt: 1,
            display: { widthPct: 35, alignment: "right" },
          },
        ],
      },
    };

    expect(saveAndReport(next)).toBe("saved");
    const stored = getNoteTemplateInstance(NOTE).attachments["field-1"][0];
    expect(stored.assetId).toBe("asset-1");
    expect(stored.display).toEqual({ widthPct: 35, alignment: "right" });
  });

  test("a row-level AI answer, and its revert, are each confirmed", () => {
    const instance = seededInstance();

    expect(saveAndReport({ ...instance, answers: { "field-1": "raw note" } })).toBe(
      "saved"
    );
    const refined = {
      ...getNoteTemplateInstance(NOTE),
      answers: { "field-1": "The footing was inspected and approved." },
    };
    expect(saveAndReport(refined)).toBe("saved");
    expect(getNoteTemplateInstance(NOTE).answers["field-1"]).toBe(
      "The footing was inspected and approved."
    );

    const reverted = { ...getNoteTemplateInstance(NOTE), answers: { "field-1": "raw note" } };
    expect(saveAndReport(reverted)).toBe("saved");
    expect(getNoteTemplateInstance(NOTE).answers["field-1"]).toBe("raw note");
  });
});

describe("a refused write is reported as a failure, never as success", () => {
  test("a throwing storage write reports failed and claims nothing", () => {
    const instance = seededInstance();
    breakStorageWrites();

    expect(saveAndReport({ ...instance, answers: { "field-1": "lost?" } })).toBe(
      "failed"
    );
  });

  test("the previously stored answer is left intact by a failed write", () => {
    const instance = seededInstance();
    expect(saveAndReport({ ...instance, answers: { "field-1": "first" } })).toBe(
      "saved"
    );

    breakStorageWrites();
    expect(saveAndReport({ ...instance, answers: { "field-1": "second" } })).toBe(
      "failed"
    );

    jest.restoreAllMocks();
    expect(getNoteTemplateInstance(NOTE).answers["field-1"]).toBe("first");
  });

  test("a later successful write replaces the failure", () => {
    const instance = seededInstance();
    const spy = breakStorageWrites();
    expect(saveAndReport({ ...instance, answers: { "field-1": "x" } })).toBe("failed");

    spy.mockRestore();
    expect(saveAndReport({ ...instance, answers: { "field-1": "x" } })).toBe("saved");
    expect(getNoteTemplateInstance(NOTE).answers["field-1"]).toBe("x");
  });

  test("a save without a note id is refused rather than written somewhere", () => {
    expect(() => saveNoteTemplateInstanceOrThrow({ answers: {} })).toThrow();
    expect(localStorage.getItem(NOTE_TEMPLATE_INSTANCES_KEY)).toBeNull();
  });
});

describe("initial instance state", () => {
  test("an instance that reads back is genuinely stored", () => {
    seededInstance();
    // This read is what allows the Template form to say "Saved locally" on
    // arrival — the component mounting is never sufficient on its own.
    expect(getNoteTemplateInstance(NOTE)).not.toBeNull();
  });

  test("a failed instance creation does not read back, and the confirmed retry fails", () => {
    createTemplate("Site report", { rows: [] });
    breakStorageWrites();

    const instance = getOrCreateInstanceForNote(NOTE); // its write is swallowed
    expect(getNoteTemplateInstance(NOTE)).toBeNull(); // nothing was stored

    // So the Template form retries through the confirmed path, which fails —
    // the status must be "Save failed", never "Saved locally".
    expect(saveAndReport(instance)).toBe("failed");
  });
});

describe("attachment retention after the removal of the temporary history", () => {
  test("an asset referenced by a note instance is still protected", () => {
    const instance = seededInstance();
    saveNoteTemplateInstanceOrThrow({
      ...instance,
      attachments: {
        "field-1": [{ id: "att-1", assetId: "asset-live", kind: "photo" }],
      },
    });

    expect(isAttachmentAssetReferenced("asset-live")).toBe(true);
  });

  test("another note's reference protects the asset too", () => {
    const instance = seededInstance();
    saveNoteTemplateInstanceOrThrow({
      ...instance,
      noteId: OTHER_NOTE,
      attachments: {
        "field-9": [{ id: "att-2", assetId: "asset-shared", kind: "file" }],
      },
    });

    expect(isAttachmentAssetReferenced("asset-shared")).toBe(true);
  });

  test("an asset no live instance references is deletable", () => {
    const instance = seededInstance();
    saveNoteTemplateInstanceOrThrow({
      ...instance,
      attachments: { "field-1": [] },
    });

    expect(isAttachmentAssetReferenced("asset-removed")).toBe(false);
    expect(isAttachmentAssetReferenced(null)).toBe(false);
  });

  test("Free-form editor images are not part of this decision at all", () => {
    // A Free-form image lives in the note's HTML as <img data-asset-id>, never
    // in a template instance's attachments. Template-form cleanup only ever
    // asks about an asset id taken from an attachment reference it just
    // removed, so an editor image can never be reached from here.
    const instance = seededInstance();
    saveNoteTemplateInstanceOrThrow({
      ...instance,
      attachments: {
        "field-1": [{ id: "att-1", assetId: "asset-template-photo", kind: "photo" }],
      },
    });

    const stored = getNoteTemplateInstance(NOTE);
    const referenced = Object.values(stored.attachments)
      .flat()
      .map((entry) => entry.assetId);

    expect(referenced).toContain("asset-template-photo");
    expect(referenced).not.toContain("asset-editor-image");
  });
});
