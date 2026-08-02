// src/lib/editorFileInsert.test.js
//
// The write ORDERING for a Free-form file attachment, which is what makes a
// failure safe: nothing enters the document until the bytes are stored, the
// originating note is re-checked after the write, and the one case where
// deleting an asset is provably safe (nothing references it) is taken while
// every other case retains it.
//
// Every platform call is injected, so this proves the sequence without a
// browser, an editor or a real IndexedDB.

import { insertFreeformFileAttachment } from "./editorFileInsert";
import {
  FILE_INSERT_MESSAGE,
  FILE_OVERSIZED_MESSAGE,
  FILE_STORAGE_MESSAGE,
  FILE_UNSUPPORTED_MESSAGE,
  MAX_EDITOR_FILE_BYTES,
} from "./editorFileAttachments";

const pdf = { name: "Q3 Report.pdf", type: "application/pdf", size: 240000 };

// Every step is recorded BEFORE it runs, including an overridden one, so the
// assertions below are about which steps were reached and in what order — not
// about which fakes happen to be installed.
function harness(overrides = {}) {
  const calls = [];
  const defaults = {
    validate: () => ({
      ok: true,
      mimeType: "application/pdf",
      extension: ".pdf",
      rewrap: false,
    }),
    rewrapBlob: (file, mimeType) => ({ size: file.size, type: mimeType }),
    createAsset: () => Promise.resolve("3f9a1c02-7b41-4a55-9f2e-11c0de4a77bd"),
    removeAsset: () => Promise.resolve(),
    insertNode: (_editor, attrs) => ({ ok: true, assetId: attrs.assetId }),
  };

  const record = {
    validate: (args) => ["validate", args[0]],
    rewrapBlob: (args) => ["rewrapBlob", args[0], args[1]],
    createAsset: (args) => ["createAsset", args[0], args[1]],
    removeAsset: (args) => ["removeAsset", args[0]],
    insertNode: (args) => ["insertNode", args[1]],
  };

  const deps = {};
  for (const step of Object.keys(defaults)) {
    const impl = overrides[step] || defaults[step];
    deps[step] = (...args) => {
      calls.push(record[step](args));
      return impl(...args);
    };
  }

  return { calls, deps, names: () => calls.map((c) => c[0]) };
}

describe("the happy path", () => {
  test("stores the bytes BEFORE inserting the node", async () => {
    const h = harness();
    const result = await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => true },
      h.deps
    );
    expect(result.ok).toBe(true);
    expect(result.assetId).toBe("3f9a1c02-7b41-4a55-9f2e-11c0de4a77bd");
    expect(h.names()).toEqual(["validate", "createAsset", "insertNode"]);
  });

  test("the node carries only the reference and safe display metadata", async () => {
    const h = harness();
    await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => true },
      h.deps
    );
    const [, attrs] = h.calls.find((c) => c[0] === "insertNode");
    expect(attrs).toEqual({
      assetId: "3f9a1c02-7b41-4a55-9f2e-11c0de4a77bd",
      name: "Q3 Report.pdf",
      mimeType: "application/pdf",
      size: 240000,
    });
    // Nothing resembling bytes, a URL or runtime state is handed to the editor.
    expect(JSON.stringify(attrs)).not.toMatch(/blob:|base64|data:/);
  });

  test("the filename is sanitized before it reaches the document", async () => {
    const h = harness();
    await insertFreeformFileAttachment(
      {
        file: { ...pdf, name: "../../etc/Q3 Report.pdf" },
        editor: {},
        isCurrentTarget: () => true,
      },
      h.deps
    );
    const [, attrs] = h.calls.find((c) => c[0] === "insertNode");
    expect(attrs.name).toBe("etc Q3 Report.pdf");
  });

  test("nothing is deleted once the reference exists", async () => {
    const h = harness();
    await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => true },
      h.deps
    );
    expect(h.names()).not.toContain("removeAsset");
  });
});

describe("generic MIME normalization", () => {
  test("a generic type re-wraps the SAME bytes with the canonical type", async () => {
    const h = harness({
      validate: () => ({
        ok: true,
        mimeType: "application/pdf",
        extension: ".pdf",
        rewrap: true,
      }),
    });
    const source = { ...pdf, type: "application/octet-stream" };
    const result = await insertFreeformFileAttachment(
      { file: source, editor: {}, isCurrentTarget: () => true },
      h.deps
    );
    expect(result.ok).toBe(true);

    const [, wrapped, mime] = h.calls.find((c) => c[0] === "rewrapBlob");
    expect(wrapped).toBe(source); // the same bytes, not a copy or an encoding
    expect(mime).toBe("application/pdf");

    // The asset is stored with the canonical type, never as octet-stream.
    const [, storedBlob, options] = h.calls.find((c) => c[0] === "createAsset");
    expect(storedBlob.type).toBe("application/pdf");
    expect(options.name).toBe("Q3 Report.pdf");
    expect(options.metadata.canonicalMimeType).toBe("application/pdf");
    expect(options.metadata.declaredMimeType).toBe("application/octet-stream");
    expect(options.metadata.normalizedFromGenericMimeType).toBe(true);
  });

  test("a real declared type is stored without re-wrapping", async () => {
    const h = harness();
    await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => true },
      h.deps
    );
    expect(h.names()).not.toContain("rewrapBlob");
    const [, storedBlob] = h.calls.find((c) => c[0] === "createAsset");
    expect(storedBlob).toBe(pdf);
  });
});

describe("a rejected file", () => {
  test("stores nothing and inserts nothing", async () => {
    const h = harness({
      validate: () => ({ ok: false, error: FILE_UNSUPPORTED_MESSAGE }),
    });
    const result = await insertFreeformFileAttachment(
      { file: { name: "payload.exe", type: "application/pdf", size: 10 }, editor: {} },
      h.deps
    );
    expect(result).toEqual({ ok: false, error: FILE_UNSUPPORTED_MESSAGE });
    expect(h.names()).toEqual(["validate"]);
  });

  test("an oversized file never reaches storage", async () => {
    const h = harness({
      validate: () => ({ ok: false, error: FILE_OVERSIZED_MESSAGE }),
    });
    const result = await insertFreeformFileAttachment(
      { file: { ...pdf, size: MAX_EDITOR_FILE_BYTES + 1 }, editor: {} },
      h.deps
    );
    expect(result.error).toBe(FILE_OVERSIZED_MESSAGE);
    expect(h.names()).toEqual(["validate"]);
  });
});

describe("a failed asset write", () => {
  test("inserts no node and reports the storage message", async () => {
    const h = harness({
      createAsset: () => Promise.reject(new Error("QuotaExceededError")),
    });
    const result = await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => true },
      h.deps
    );
    expect(result).toEqual({ ok: false, error: FILE_STORAGE_MESSAGE });
    expect(h.names()).toEqual(["validate", "createAsset"]);
    // The raw exception text is never handed to the caller.
    expect(result.error).not.toMatch(/Quota/);
  });

  test("a write that resolves without an id is treated as a failure", async () => {
    const h = harness({ createAsset: () => Promise.resolve(null) });
    const result = await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => true },
      h.deps
    );
    expect(result.ok).toBe(false);
    expect(h.names()).not.toContain("insertNode");
  });
});

describe("a failed node insertion", () => {
  test("deletes the now-unreferenced asset", async () => {
    const h = harness({
      insertNode: () => ({ ok: false, error: FILE_INSERT_MESSAGE }),
    });
    const result = await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => true },
      h.deps
    );
    expect(result).toEqual({ ok: false, error: FILE_INSERT_MESSAGE });
    expect(h.names()).toEqual([
      "validate",
      "createAsset",
      "insertNode",
      "removeAsset",
    ]);
    const [, deletedId] = h.calls.find((c) => c[0] === "removeAsset");
    expect(deletedId).toBe("3f9a1c02-7b41-4a55-9f2e-11c0de4a77bd");
  });

  test("a throwing editor is handled the same way", async () => {
    const h = harness({
      insertNode: () => {
        throw new Error("schema error");
      },
    });
    const result = await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => true },
      h.deps
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe(FILE_INSERT_MESSAGE);
    expect(h.names()).toContain("removeAsset");
  });

  test("a cleanup failure is swallowed rather than shown as a second error", async () => {
    const h = harness({
      insertNode: () => ({ ok: false, error: FILE_INSERT_MESSAGE }),
      removeAsset: () => Promise.reject(new Error("delete failed")),
    });
    const result = await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => true },
      h.deps
    );
    expect(result).toEqual({ ok: false, error: FILE_INSERT_MESSAGE });
  });
});

describe("note and view identity", () => {
  test("a note switch during the write inserts nothing anywhere", async () => {
    const h = harness({ insertNode: () => ({ ok: true }) });
    const result = await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => false },
      h.deps
    );
    expect(result).toEqual({ ok: false, stale: true });
    expect(h.names()).toEqual(["validate", "createAsset", "removeAsset"]);
    expect(h.names()).not.toContain("insertNode");
  });

  test("a stale write deletes its own newly created asset", async () => {
    const h = harness();
    await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => false },
      h.deps
    );
    const [, deletedId] = h.calls.find((c) => c[0] === "removeAsset");
    expect(deletedId).toBe("3f9a1c02-7b41-4a55-9f2e-11c0de4a77bd");
  });

  test("a stale write reports neither success nor a user-facing error", async () => {
    const h = harness();
    const result = await insertFreeformFileAttachment(
      { file: pdf, editor: {}, isCurrentTarget: () => false },
      h.deps
    );
    // The caller must stay silent: a message would describe a note that is no
    // longer on screen.
    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("the identity check runs AFTER the write, never before it", async () => {
    const order = [];
    const h = harness({ createAsset: () => {
      order.push("createAsset");
      return Promise.resolve("3f9a1c02-7b41-4a55-9f2e-11c0de4a77bd");
    } });
    await insertFreeformFileAttachment(
      {
        file: pdf,
        editor: {},
        isCurrentTarget: () => {
          order.push("isCurrentTarget");
          return true;
        },
      },
      h.deps
    );
    expect(order).toEqual(["createAsset", "isCurrentTarget"]);
  });

  test("a throwing identity check is treated as stale, not as success", async () => {
    const h = harness();
    const result = await insertFreeformFileAttachment(
      {
        file: pdf,
        editor: {},
        isCurrentTarget: () => {
          throw new Error("gone");
        },
      },
      h.deps
    );
    expect(result).toEqual({ ok: false, stale: true });
    expect(h.names()).toContain("removeAsset");
  });
});
