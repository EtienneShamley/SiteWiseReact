// src/lib/assetReferences.test.js
//
// ASSET REFERENCE MANIFEST (Phase 4 brief §8 groundwork): every place an
// asset id can live is collected, once, tolerantly.
import {
  htmlAssetIds,
  instanceAssetIds,
  liveAssetIds,
  noteAssetManifest,
  recordedLiveAssetIds,
  templateVersionAssetIds,
} from "./assetReferences";

const HTML =
  '<p>Photo</p><img data-asset-id="img-1" alt="">' +
  '<img data-asset-id="rend-1" data-annotation-source-id="img-orig" alt="">' +
  '<a data-file-asset-id="file-1">plan.pdf</a>' +
  '<img data-asset-id="img-1" alt="">'; // duplicate reference

test("HTML: images, files and rendition sources, de-duplicated", () => {
  expect(htmlAssetIds(HTML).sort()).toEqual(["file-1", "img-1", "img-orig", "rend-1"]);
  expect(htmlAssetIds("")).toEqual([]);
  expect(htmlAssetIds(null)).toEqual([]);
  expect(htmlAssetIds("<p>no assets</p>")).toEqual([]);
});

test("instance: attachments, evidence, section items (never text), and section documents", () => {
  const instance = {
    attachments: { f1: [{ id: "a", assetId: "att-1" }, "legacy-base64-string", null] },
    evidence: { f2: [{ id: "b", assetId: "ev-1" }] },
    sectionContent: {
      r1: [
        { id: "t", kind: "text", text: "hello", assetId: "must-not-count" },
        { id: "p", kind: "photo", assetId: "sec-photo" },
        7,
      ],
      broken: "not a list",
    },
    sectionDoc: {
      r2: { format: "sectiondoc/1", html: '<img data-asset-id="doc-img">' },
      r3: "not an object",
    },
  };
  expect(instanceAssetIds(instance).sort()).toEqual(["att-1", "doc-img", "ev-1", "sec-photo"]);
  expect(instanceAssetIds(null)).toEqual([]);
  expect(instanceAssetIds({})).toEqual([]);
});

test("note manifest is the union of content and instance, either may be absent", () => {
  const manifest = noteAssetManifest({
    html: '<img data-asset-id="shared">',
    instance: { attachments: { f: [{ assetId: "shared" }, { assetId: "only-inst" }] } },
  });
  expect(manifest.sort()).toEqual(["only-inst", "shared"]);
  expect(noteAssetManifest({})).toEqual([]);
  expect(noteAssetManifest()).toEqual([]);
});

test("template versions contribute their logo ids", () => {
  expect(
    templateVersionAssetIds({
      v1: { logoAssetId: "logo-a" },
      v2: { logoAssetId: "logo-a" },
      v3: { logoSrc: "data:image/png;base64,AAA" },
      v4: null,
    })
  ).toEqual(["logo-a"]);
  expect(templateVersionAssetIds(null)).toEqual([]);
});

test("the live set (mark set) unions notes, versions and rendition sources", () => {
  const live = liveAssetIds({
    notes: [{ html: '<img data-asset-id="n1">' }, { instance: { evidence: { f: [{ assetId: "n2" }] } } }, null],
    versions: { v: { logoAssetId: "logo" } },
    renditionSources: ["orig", ""],
  });
  expect([...live].sort()).toEqual(["logo", "n1", "n2", "orig"]);
  // A shared asset referenced by two notes appears once and is protected.
  const shared = liveAssetIds({
    notes: [{ html: '<img data-asset-id="s">' }, { html: '<img data-asset-id="s">' }],
  });
  expect(shared.has("s")).toBe(true);
  expect(shared.size).toBe(1);
});

/* ------------- the record-shaped entry point (Phase 7.6 / GC) ------------- */

test("recordedLiveAssetIds is the SAME universe, expressed over the durable records", () => {
  const noteContent = { n1: '<img data-asset-id="a">', n2: '<a data-file-asset-id="b"></a>' };
  const templateInstances = { n2: { attachments: { r: [{ assetId: "c" }] } }, n3: { evidence: { r: [{ assetId: "d" }] } } };
  const templateVersions = { v: { logoAssetId: "logo" } };

  const fromRecords = recordedLiveAssetIds({ noteContent, templateInstances, templateVersions });
  const fromCollector = liveAssetIds({
    notes: [
      { html: noteContent.n1 },
      { html: noteContent.n2, instance: templateInstances.n2 },
      { instance: templateInstances.n3 },
    ],
    versions: templateVersions,
  });
  expect([...fromRecords].sort()).toEqual([...fromCollector].sort());
  expect([...fromRecords].sort()).toEqual(["a", "b", "c", "d", "logo"]);
});

test("a note with BOTH free-form content and a template instance is collected once, from both", () => {
  const ids = recordedLiveAssetIds({
    noteContent: { n1: '<img data-asset-id="shared">' },
    templateInstances: { n1: { attachments: { r: [{ assetId: "shared" }, { assetId: "extra" }] } } },
  });
  expect([...ids].sort()).toEqual(["extra", "shared"]);
});

test("a referenced rendition keeps its source alive transitively; an orphaned one keeps nothing", () => {
  const assets = [
    { id: "r2", metadata: { annotation: { sourceAssetId: "r1" } } },
    { id: "r1", metadata: { annotation: { sourceAssetId: "orig" } } },
    { id: "orphan", metadata: { annotation: { sourceAssetId: "orphan-orig" } } },
  ];
  const ids = recordedLiveAssetIds({ noteContent: { n: '<img data-asset-id="r2">' }, assets });
  expect([...ids].sort()).toEqual(["orig", "r1", "r2"]);
});

test("current PDF source ids join the set unchanged; malformed input is tolerated", () => {
  expect([...recordedLiveAssetIds({ pdfSourceIds: ["src-1", "", null] })]).toEqual(["src-1"]);
  expect([...recordedLiveAssetIds()].length).toBe(0);
  expect([...recordedLiveAssetIds({ noteContent: [], templateInstances: 7, assets: null })].length).toBe(0);
});
