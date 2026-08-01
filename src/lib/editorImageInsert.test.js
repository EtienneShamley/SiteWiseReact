// src/lib/editorImageInsert.test.js
//
// The write ORDERING for a local image, which is what makes a failure safe:
// nothing enters the document until the bytes are stored, and the one case
// where deleting an asset is provably safe (an insert that failed, so nothing
// references it) is taken while every other case retains the asset.
//
// Every platform call is injected, so this proves the sequence without a
// browser, an editor or a real IndexedDB.

import { insertLocalImageAsset } from "./editorImageInsert";
import {
  IMAGE_OVERSIZED_MESSAGE,
  IMAGE_STORAGE_MESSAGE,
  IMAGE_UNSUPPORTED_MESSAGE,
  IMAGE_DECODE_MESSAGE,
} from "./imageProcessing";
import { EDITOR_IMAGE_INSERT_MESSAGE } from "./editorImageAssets";

const sourceFile = { name: "site.jpg", type: "image/jpeg", size: 2 * 1024 * 1024 };

// Every step is recorded BEFORE it runs, including an overridden one, so the
// assertions below are about which steps were reached and in what order — not
// about which fakes happen to be installed.
function harness(overrides = {}) {
  const calls = [];
  const defaults = {
    validate: () => ({ ok: true, mimeType: "image/jpeg" }),
    normalize: () =>
      Promise.resolve({
        blob: { size: 500 * 1024, type: "image/jpeg" },
        width: 1600,
        height: 1200,
        mimeType: "image/jpeg",
        processed: true,
      }),
    createAsset: () => Promise.resolve("asset-1"),
    removeAsset: () => Promise.resolve(),
    insertNode: (_editor, attrs) => ({ ok: true, assetId: attrs.assetId }),
  };

  const record = {
    validate: (args) => ["validate", args[0]],
    normalize: (args) => ["normalize", args[0], args[1]],
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
    const result = await insertLocalImageAsset(
      { sourceFile, editor: {}, name: "site.jpg" },
      h.deps
    );
    expect(result.ok).toBe(true);
    expect(result.assetId).toBe("asset-1");
    expect(h.names()).toEqual(["validate", "normalize", "createAsset", "insertNode"]);
  });

  test("the node carries the reference and the intrinsic size, never a src", async () => {
    const h = harness();
    await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    const [, attrs] = h.calls.find((c) => c[0] === "insertNode");
    expect(attrs).toEqual({
      assetId: "asset-1",
      alt: "site.jpg",
      width: 1600,
      height: 1200,
    });
    expect("src" in attrs).toBe(false);
  });

  test("a successful insert NEVER deletes the asset", async () => {
    // Once the live document references the asset, deleting it would break the
    // image the user can see — including when ordinary note persistence later
    // fails, which is exactly when the user needs it to still be there.
    const h = harness();
    await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    expect(h.names()).not.toContain("removeAsset");
  });

  test("metadata records what a future backend would need", async () => {
    const h = harness();
    await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    const [, , meta] = h.calls.find((c) => c[0] === "createAsset");
    expect(meta.name).toBe("site.jpg");
    expect(meta.metadata).toEqual({
      width: 1600,
      height: 1200,
      sourceMimeType: "image/jpeg",
      sourceSize: 2 * 1024 * 1024,
      normalized: true,
    });
  });
});

describe("validation is on the SOURCE file", () => {
  test("an unsupported file writes nothing at all", async () => {
    const h = harness({
      validate: () => ({ ok: false, error: IMAGE_UNSUPPORTED_MESSAGE }),
    });
    const result = await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    expect(result).toEqual({ ok: false, error: IMAGE_UNSUPPORTED_MESSAGE });
    expect(h.names()).toEqual(["validate"]);
  });

  test("an oversized file is rejected before normalization", async () => {
    const h = harness({
      validate: () => ({ ok: false, error: IMAGE_OVERSIZED_MESSAGE }),
    });
    const result = await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    expect(result.error).toBe(IMAGE_OVERSIZED_MESSAGE);
    expect(h.names()).not.toContain("normalize");
  });

  test("a derived blob is what gets stored, but the SOURCE is what is checked", async () => {
    // The BottomBar stamped-capture case: the source was already validated, and
    // our own canvas output must not be re-measured against the input limit.
    const stamped = { size: 30 * 1024 * 1024, type: "image/jpeg" };
    const h = harness();
    await insertLocalImageAsset({ sourceFile, blob: stamped, editor: {} }, h.deps);
    const [, validated] = h.calls.find((c) => c[0] === "validate");
    const [, normalized] = h.calls.find((c) => c[0] === "normalize");
    expect(validated).toBe(sourceFile);
    expect(normalized).toBe(stamped);
  });

  test("the source type is passed on as the preferred output format", async () => {
    const h = harness();
    await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    const [, , opts] = h.calls.find((c) => c[0] === "normalize");
    expect(opts).toEqual({ preferredMimeType: "image/jpeg" });
  });
});

describe("failure paths", () => {
  test("a processing failure stores nothing and inserts nothing", async () => {
    const h = harness({
      normalize: () => Promise.reject(new Error(IMAGE_DECODE_MESSAGE)),
    });
    const result = await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    expect(result).toEqual({ ok: false, error: IMAGE_DECODE_MESSAGE });
    expect(h.names()).toEqual(["validate", "normalize"]);
  });

  test("a storage failure inserts no node and reports the storage message", async () => {
    const h = harness({ createAsset: () => Promise.reject(new Error("QuotaExceeded")) });
    const result = await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    expect(result).toEqual({ ok: false, error: IMAGE_STORAGE_MESSAGE });
    expect(h.names()).not.toContain("insertNode");
  });

  test("a FAILED insertion deletes the now-unreferenced asset immediately", async () => {
    const h = harness({
      insertNode: () => ({ ok: false, error: EDITOR_IMAGE_INSERT_MESSAGE }),
    });
    const result = await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    expect(result.ok).toBe(false);
    expect(h.names()).toEqual([
      "validate",
      "normalize",
      "createAsset",
      "insertNode",
      "removeAsset",
    ]);
    expect(h.calls.find((c) => c[0] === "removeAsset")[1]).toBe("asset-1");
  });

  test("an insertion that THROWS is treated the same way", async () => {
    const h = harness({
      insertNode: () => {
        throw new Error("schema refused the node");
      },
    });
    const result = await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    expect(result.ok).toBe(false);
    expect(h.names()).toContain("removeAsset");
  });

  test("a cleanup that itself fails is not reported as a second failure", async () => {
    const h = harness({
      insertNode: () => ({ ok: false, error: "nope" }),
      removeAsset: () => Promise.reject(new Error("delete failed")),
    });
    const result = await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    expect(result).toEqual({ ok: false, error: "nope" });
  });

  test("an asset id that never materialises reports storage failure", async () => {
    const h = harness({ createAsset: () => Promise.resolve(null) });
    const result = await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
    expect(result.error).toBe(IMAGE_STORAGE_MESSAGE);
    expect(h.names()).not.toContain("insertNode");
  });

  test("no failure path ever reports success", async () => {
    for (const override of [
      { validate: () => ({ ok: false, error: "x" }) },
      { normalize: () => Promise.reject(new Error("y")) },
      { createAsset: () => Promise.reject(new Error("z")) },
      { insertNode: () => ({ ok: false, error: "w" }) },
    ]) {
      const h = harness(override);
      const result = await insertLocalImageAsset({ sourceFile, editor: {} }, h.deps);
      expect(result.ok).toBe(false);
      expect(result.assetId).toBeUndefined();
    }
  });
});
