// src/lib/templateQuickAddWiring.test.js
//
// Template Quick Add: staging, the camera-vs-ordinary-upload split, and the
// section delivery wiring.
//
// Source-text assertions, used for the one job they do well: proving
// component-level facts that no pure module can hold. There is no DOM testing
// library in this project (see docs/TESTING.md), so "choosing a photo for a
// Template row writes nothing to the note", "an ordinary upload never reaches
// the stamping pipeline" and "the structural callback is the real handler, not
// a no-op" cannot be shown any other way.
//
// The BEHAVIOUR itself is proved in the neighbouring pure suites:
//   - the staged queue and its object-URL lifecycle:   quickAddDraft.test.js
//   - which destinations compose, and the Send route:  quickAddDraft.test.js
//   - order, partial success, text-after-attachments:  quickAddDelivery.test.js
//   - the attachment write/removal sequences:  templateSectionAttachments.test.js
//   - the text append + materialise-once rule:     templateSectionText.test.js
//   - what a destination may accept:                  quickAddTarget.test.js
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

// Comment prose necessarily describes both the old and the new behaviour; the
// checks below look at code only.
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const bottomBarSource = read("components/BottomBar.js");
const bottomBar = withoutComments(bottomBarSource);
const mainArea = withoutComments(read("components/MainArea.js"));
const templateDoc = withoutComments(read("components/template/NoteTemplateDoc.js"));

const between = (source, from, to) =>
  source.slice(source.indexOf(from), source.indexOf(to));

const templateSend = between(
  mainArea,
  "async function handleTemplateComposerSend",
  "async function handleQuickAddComposerSend"
);

/* -------------------------------------------------------------------------- */
/* 1. A Template capture STAGES — nothing is written before Send               */
/* -------------------------------------------------------------------------- */

describe("a Template row capture stages and persists nothing", () => {
  test("a selected Template row is a composing destination", () => {
    const draft = withoutComments(read("lib/quickAddDraft.js"));
    expect(draft).toMatch(
      /target\.kind === QUICK_ADD_KIND\.FREEFORM[\s\S]{0,120}?target\.kind === QUICK_ADD_KIND\.TEMPLATE_ROW/
    );
    expect(bottomBar).toMatch(/stagingEnabled = quickAddStagingEnabled\(\{/);
  });

  test("the picker and the camera both take the staging branch first", () => {
    const picker = between(bottomBar, "const handleFilesSelected", "const handleCameraSelected");
    const camera = between(bottomBar, "const handleCameraSelected", "const pickMimeType");
    for (const handler of [picker, camera]) {
      expect(handler).toMatch(/if \(stagingEnabled\)/);
      const staged = handler.slice(handler.indexOf("if (stagingEnabled)"));
      // The staging branch always returns before the immediate-insert fallback.
      expect(staged).toMatch(/return;/);
    }
  });

  test("staging writes to the draft store and to nothing else", () => {
    const staging = between(bottomBar, "async function stagePhoto", "const removeStagedAttachment");
    expect(staging).toMatch(/draftStoreRef\.current\.add\(\{/);
    // No note write, no attachment reference, no asset, no storage of any kind.
    expect(staging).not.toMatch(/onInsertImage|onInsertFile|insertContent/);
    expect(staging).not.toMatch(/createPhotoAsset|createNoteFileAsset|createEditorImageAsset/);
    expect(staging).not.toMatch(/localStorage|indexedDB|saveNoteTemplateInstance/);
    expect(staging).not.toMatch(/appendSectionAttachment|appendSectionText|sectionContent/);
  });

  test("the whole capture bar can reach no persistence at all", () => {
    expect(bottomBar).not.toMatch(/saveNoteTemplateInstance|assetStorage|indexedDB/);
    expect(bottomBar).not.toMatch(/sectionContent/);
  });

  test("removing a draft before Send only touches the queue", () => {
    expect(bottomBar).toMatch(
      /const removeStagedAttachment = \(id\) => \{\s*if \(draftStoreRef\.current\.remove\(id\)\) syncStaged\(\);/
    );
    // The store's own remove revokes the preview URL; it is the only effect.
    const draft = withoutComments(read("lib/quickAddDraft.js"));
    expect(draft).toMatch(/remove\(id\) \{[\s\S]{0,240}?revoke\(item\)/);
    expect(draft).not.toMatch(/localStorage|indexedDB|assetStorage/);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. CAMERA vs ORDINARY UPLOAD                                                */
/* -------------------------------------------------------------------------- */

describe("the camera is stamped and the ordinary picker is not", () => {
  test("every image path states its intent explicitly", () => {
    // The picker — staging and the immediate fallback.
    expect(bottomBar).toMatch(/stagePhoto\(f, \{ stamp: false \}\)/);
    expect(bottomBar).toMatch(/insertPhoto\(f, insertPoint, \{ stamp: false \}\)/);
    // The camera — staging and the immediate fallback.
    expect(bottomBar).toMatch(/stagePhoto\(f, \{ stamp: true \}\)/);
    expect(bottomBar).toMatch(/insertPhoto\(f, insertPoint, \{ stamp: true \}\)/);
  });

  test("`stamp: true` appears ONLY in the camera handler", () => {
    const camera = between(bottomBar, "const handleCameraSelected", "const pickMimeType");
    const stampTrue = bottomBar.match(/stamp: true/g) || [];
    const cameraStampTrue = camera.match(/stamp: true/g) || [];
    expect(stampTrue).toHaveLength(cameraStampTrue.length);
    expect(cameraStampTrue.length).toBeGreaterThan(0);
  });

  test("the picker handler never asks for a stamp", () => {
    const picker = between(bottomBar, "const handleFilesSelected", "const handleCameraSelected");
    expect(picker).not.toMatch(/stamp: true/);
    expect(picker).toMatch(/stamp: false/);
  });

  test("the stamp builder is reached only behind the stamp flag", () => {
    const prepare = between(bottomBar, "async function preparePhotoBytes", "async function insertPhoto");
    // An unstamped request returns the picked file before any stamping work.
    expect(prepare).toMatch(
      /if \(!stamp\) \{[\s\S]{0,160}?return \{ blob: file, mimeType: check\.mimeType \};/
    );
    expect(prepare.indexOf("if (!stamp)")).toBeLessThan(
      prepare.indexOf("buildStampedImageBLOB(file")
    );
    // Exactly one call site in the whole file (plus the definition).
    expect(bottomBar.match(/buildStampedImageBLOB\(/g) || []).toHaveLength(2);
  });

  test("an ordinary upload cannot request location, geocoding or a map", () => {
    // Every location/map effect lives inside buildStampedImageBLOB, which an
    // unstamped request never reaches — so picking a picture never prompts for
    // location permission and never draws a map on it.
    const stampBuilder = between(
      bottomBar,
      "async function buildStampedImageBLOB",
      "async function preparePhotoBytes"
    );
    for (const effect of ["getBrowserGeo", "reverseGeocode", "getExifGeoAndTime", "drawMapThumbnail"]) {
      const all = bottomBar.match(new RegExp(`${effect}\\(`, "g")) || [];
      const inBuilder = stampBuilder.match(new RegExp(`${effect}\\(`, "g")) || [];
      // 1 definition + calls, and every call is inside the stamp builder.
      expect(all.length).toBe(inBuilder.length + 1);
      expect(inBuilder.length).toBeGreaterThan(0);
    }
  });

  test("navigator.geolocation is reachable from exactly one function", () => {
    const geo = between(bottomBar, "function getBrowserGeo", "async function reverseGeocode");
    expect(geo).toMatch(/navigator\.geolocation\.getCurrentPosition/);
    expect((bottomBar.match(/navigator\?\.geolocation|navigator\.geolocation/g) || []).length)
      .toBe((geo.match(/navigator\?\.geolocation|navigator\.geolocation/g) || []).length);
  });

  test("the STAMPED bytes are what gets staged, and the original is not", () => {
    const staging = between(bottomBar, "async function stagePhoto", "function stageAttachedFile");
    expect(staging).toMatch(/const prepared = await preparePhotoBytes\(file, \{ stamp \}\)/);
    expect(staging).toMatch(/payload: prepared\.blob/);
    expect(staging).not.toMatch(/payload: file/);
  });

  test("the staged payload is what Send persists", () => {
    expect(mainArea).toMatch(/const payload = item\?\.payload/);
    expect(templateSend).toMatch(/const file = stagedDraftAsFile\(item\)/);
    expect(templateSend).not.toMatch(/previewUrl/);
  });

  test("a failed stamp keeps the capture instead of losing it", () => {
    // Geolocation denied, an unreachable map tile or a canvas that produced
    // nothing must not cost the user their photo.
    expect(bottomBar).toMatch(/return \{ blob: stamped \|\| file, mimeType: check\.mimeType \}/);
    // A missing position simply omits those lines; it is not an error.
    expect(bottomBar).toMatch(/if \(lat == null \|\| lon == null\) return;/);
    expect(bottomBar).toMatch(/if \(!mapImg\) return;/);
  });

  test("a document is never stamped, on either path", () => {
    const camera = between(bottomBar, "const handleCameraSelected", "const pickMimeType");
    expect(camera).toMatch(/bottomBarRouteFor\(f\) !== "image"[\s\S]{0,200}?stageAttachedFile\(f\)/);
    const fileStaging = between(bottomBar, "function stageAttachedFile", "const removeStagedAttachment");
    expect(fileStaging).not.toMatch(/preparePhotoBytes|buildStampedImageBLOB|stamp/);
  });

  test("no structured GPS/address metadata is produced anywhere", () => {
    // The stamp is, and stays, visible pixels in the Blob.
    for (const source of [bottomBar, mainArea, templateDoc]) {
      expect(source).not.toMatch(/capturedAt|gpsLatitude|gpsLongitude|\bcoordinates:/);
    }
    // The staged draft carries bytes, a name and a MIME type — no position.
    const draft = withoutComments(read("lib/quickAddDraft.js"));
    expect(draft).not.toMatch(/\b(latitude|longitude|geolocation|gps)\b/i);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Delivery — one destination, captured once                                */
/* -------------------------------------------------------------------------- */

describe("the Template composition is delivered to one captured destination", () => {
  test("the destination is the resolved target, i.e. activeTemplateRowId", () => {
    expect(templateSend).toMatch(/const target = quickAddTarget/);
    expect(templateSend).toMatch(/target\.kind !== QUICK_ADD_KIND\.TEMPLATE_ROW/);
    expect(templateSend).toMatch(/const rowId = target\.rowId/);
    // Row-level, never item-level: no section item id is a Quick Add target.
    expect(templateSend).not.toMatch(/itemId|activeSectionItemId|sectionItem/);
  });

  test("activeTemplateRowId remains the single selection authority", () => {
    expect(mainArea).toMatch(/rowId: activeTemplateRowId/);
    expect(mainArea).toMatch(/quickAddTargetRowId=\{activeTemplateRowId\}/);
  });

  test("the token is captured ONCE and re-checked before every item", () => {
    expect(templateSend).toMatch(/const capturedToken = quickAddTokenRef\.current/);
    expect(templateSend).toMatch(
      /isCurrentTarget = \(\) =>[\s\S]{0,320}?quickAddTokenRef\.current === capturedToken/
    );
    const attach = between(templateSend, "insertAttachment: async (item)", "insertText:");
    expect(attach).toMatch(/if \(!isCurrentTarget\(\)\)/);
    const text = templateSend.slice(templateSend.indexOf("insertText: (value)"));
    expect(text).toMatch(/if \(!isCurrentTarget\(\)\)/);
  });

  test("a stale destination REFUSES rather than redirecting", () => {
    const attach = between(templateSend, "insertAttachment: async (item)", "insertText:");
    const stale = attach.slice(attach.indexOf("if (!isCurrentTarget())"));
    expect(stale).toMatch(/return \{ ok: false, stale: true \}/);
    // Nothing recomputes a row id from the LIVE selection after the capture.
    expect(templateSend).not.toMatch(/activeTemplateRowId/);
  });

  test("the note and the view are part of that check", () => {
    expect(templateSend).toMatch(/noteKeyRef\.current === originNoteId/);
    expect(templateSend).toMatch(/noteLayoutRef\.current === "template"/);
    expect(templateSend).toMatch(/!!templateComposeRef\.current/);
  });

  test("switching note or destination drops unsent drafts in the capture bar", () => {
    expect(bottomBar).toMatch(/clearStaged\(\);[\s\S]{0,140}?\}, \[currentNoteId\]\)/);
    expect(bottomBar).toMatch(/clearStaged\(\);[\s\S]{0,180}?\}, \[targetToken\]\)/);
  });

  test("the ONE composer contract is reused, not reimplemented", () => {
    expect(templateSend).toMatch(/await deliverQuickAddComposer\(\{/);
    // A section has no caret: nothing is placed and no block is opened.
    expect(templateSend).not.toMatch(/placeCaret|openBlockAfterAttachment|restoreFreeformInsertPoint/);
    expect(templateSend).not.toMatch(/insertLocalImageAsset|insertFreeformFileAttachment/);
  });

  test("delivery goes through the registered section composer only", () => {
    expect(templateSend).toMatch(/compose\.appendAttachment\(rowId, \{/);
    expect(templateSend).toMatch(/compose\.appendText\(rowId, value\)/);
    // No second attachment implementation, no storage, in MainArea.
    expect(templateSend).not.toMatch(/createPhotoAsset|createNoteFileAsset|deleteAsset/);
    expect(templateSend).not.toMatch(/localStorage|indexedDB/);
  });

  test("the composer send handler dispatches the Template form here", () => {
    expect(mainArea).toMatch(
      /handleQuickAddComposerSend[\s\S]{0,600}?noteLayoutRef\.current === "template"[\s\S]{0,120}?return handleTemplateComposerSend/
    );
  });

  test("partial success is reported through the shared result shape", () => {
    // deliveredIds decides what leaves the queue; a failed item stays staged and
    // a delivered one cannot be sent twice. That logic is the shared one.
    expect(templateSend).toMatch(/return \{ \.\.\.result, stale: result\.stale \|\| staleReported \}/);
    expect(bottomBar).toMatch(/applyQuickAddSendResult\(result, \{/);
    expect(bottomBar).toMatch(/draftStoreRef\.current\.removeMany\(deliveredIds\)/);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Text and voice                                                           */
/* -------------------------------------------------------------------------- */

describe("Template Quick Add text becomes section content, never an answer", () => {
  test("a Template row routes its text through the composer", () => {
    expect(bottomBar).toMatch(
      /const textUsesComposer = target\?\.kind === QUICK_ADD_KIND\.TEMPLATE_ROW/
    );
    expect(bottomBar).toMatch(/textUsesComposer,/);
  });

  test("the text half calls the section text primitive", () => {
    expect(templateDoc).toMatch(/const result = appendSectionText\(\{/);
    const appendText = between(
      templateDoc,
      "const appendComposedText = useCallback(",
      "const templateComposeApi"
    );
    // It has no answers channel at all.
    expect(appendText).not.toMatch(/setRowText|rowTextRef\.current =|handleRightChange|appendTextToAnswer/);
    expect(appendText).not.toMatch(/persistCustomRows|handleCustomRowPatch/);
    expect(appendText).toMatch(/persist: persistSectionContent/);
  });

  test("voice only fills the composer's text draft", () => {
    const voice = between(bottomBar, "const handleVoiceClick", "const runRefine");
    expect(voice).toMatch(/setRefinedDraft\(|setInput\(/);
    expect(voice).not.toMatch(/onSendComposer|handleSend|draftStoreRef|onInsertText/);
    // A result whose destination has moved is discarded, not redirected.
    expect(voice).toMatch(/capturedTarget !== targetTokenRef\.current/);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The live-editor transition                                               */
/* -------------------------------------------------------------------------- */

describe("a live legacy editor is transitioned, not left writing the frozen answer", () => {
  const structural = between(
    templateDoc,
    "const handleSectionStructuralChange = useCallback(",
    "const sectionMaterialisationFor"
  );

  test("onStructuralChange is wired to the real handler on BOTH primitives", () => {
    const attachments = (templateDoc.match(/onStructuralChange: handleSectionStructuralChange/g) || []);
    expect(attachments.length).toBeGreaterThanOrEqual(2);
    expect(templateDoc).not.toMatch(/onStructuralChange: \(\) => \{\}/);
    expect(templateDoc).not.toMatch(/onStructuralChange: noop/);
  });

  test("materialisedTextItemId is ADOPTED by the editing session", () => {
    expect(structural).toMatch(/if \(materialisedTextItemId\)/);
    expect(structural).toMatch(/activeTextRowIdRef\.current === rowId/);
    expect(structural).toMatch(/!activeSectionItemIdRef\.current/);
    expect(structural).toMatch(/itemId: materialisedTextItemId/);
    expect(structural).toMatch(/materializedSectionRef\.current = record/);
    expect(structural).toMatch(/setMaterializedSection\(record\)/);
  });

  test("adoption is what makes the next keystroke reach the new item", () => {
    // Route 1 of the change handler uses exactly this record.
    expect(templateDoc).toMatch(
      /activeSectionItemIdRef\.current \|\|\s*\n?\s*\(materialized && materialized\.rowId === rowId \? materialized\.itemId : null\)/
    );
    expect(templateDoc).toMatch(/if \(itemId\) \{[\s\S]{0,400}?updateTextSectionItemValue/);
  });

  test("a removed item's session is dropped, and never re-pointed at a neighbour", () => {
    // Superseded by the Word-flow correction: the handler now delegates to
    // `forgetRemovedSectionItems`, which HEALING also uses (a heal removes a
    // continuation item exactly as a removal removes an attachment). The rule
    // itself is unchanged — the item is named by its own id, and nothing looks
    // for a neighbour to fall back on.
    expect(structural).toMatch(
      /if \(removedItemId\) forgetRemovedSectionItems\(rowId, \[removedItemId\]\)/
    );
    const forget = templateDoc.slice(
      templateDoc.indexOf("const forgetRemovedSectionItems = useCallback("),
      templateDoc.indexOf("const persistSectionContentHealed")
    );
    expect(forget).toMatch(/ids\.includes\(materializing\.itemId\)/);
    expect(forget).toMatch(/clearMaterializedSection\(\)/);
    // No search for "some other text item" anywhere in the cleanup.
    expect(forget).not.toMatch(/findIndex\(/);
  });

  test("the editor's identity is carried into the record, not invented", () => {
    expect(structural).toMatch(/identity: activeRowIdentityRef\.current/);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. What Quick Add must never touch                                          */
/* -------------------------------------------------------------------------- */

describe("primary values are untouched by a Quick Add composition", () => {
  const composeBlock = between(
    templateDoc,
    "const appendComposedAttachment = useCallback(",
    "const templateComposeApi"
  );

  test("neither composer writes answers, custom-row answers or attachments", () => {
    expect(composeBlock).not.toMatch(/setRowText|setRowAttachments|setRowEvidence/);
    expect(composeBlock).not.toMatch(/persistAttachments|persistEvidence|persistCustomRows/);
    expect(composeBlock).toMatch(/persist: persistSectionContent/);
  });

  test("a structured and a legacy Photo/File row are never materialised", () => {
    const materialisation = between(
      templateDoc,
      "const sectionMaterialisationFor = useCallback(",
      "const appendComposedAttachment"
    );
    // isTextAnswerRow is false for number/date/time/checkbox/yes-no/select and
    // for the legacy photo/file types, so those pass materialisation: null.
    expect(materialisation).toMatch(/if \(!isTextAnswerRow\(rowId\)\) return null;/);
    expect(materialisation).toMatch(/evidence: rowEvidenceRef\.current\?\.\[rowId\]/);
  });

  test("the section save carries answers/attachments/evidence through unchanged", () => {
    expect(templateDoc).toMatch(
      /const persistSectionContent = useCallback\([\s\S]{0,600}?answers: rowTextRef\.current,[\s\S]{0,120}?attachments: rowAttachmentsRef\.current,[\s\S]{0,120}?evidence: rowEvidenceRef\.current,/
    );
  });

  test("the row's own direct Photo/File upload control is unchanged", () => {
    expect(templateDoc).toMatch(/const handleAddAttachments = useCallback\(/);
    expect(templateDoc).toMatch(/collectionRef: rowAttachmentsRef/);
    expect(templateDoc).toMatch(/const handleRemoveAttachment = useCallback\(/);
    expect(templateDoc).toMatch(/onAddAttachments|onRemoveAttachment/);
  });

  test("no TemplateVersion is ever written from any of these paths", () => {
    for (const source of [bottomBar, mainArea, templateDoc]) {
      expect(source).not.toMatch(/publishVersion|saveVersion|createVersion|updateVersion/);
    }
  });
});

describe("persisted section photos keep their display metadata read-only", () => {
  const table = withoutComments(read("components/template/ResizableTwoColTable.js"));
  const sectionBody = between(
    table,
    "function renderSectionItemBody",
    "function renderSectionSegment"
  );

  test("a section photo renders with readOnly and no legacy display toolbar", () => {
    // The Small/Normal/Large/Full-width presets and the alignment buttons are
    // removed, not re-exposed: a section image is sized by its own proportional
    // corner handles instead. Per-item REMOVE is a separate capability and is
    // proved in templateSectionComposition.test.js.
    expect(sectionBody).toMatch(
      /<PhotoAttachment\s+attachment=\{item\}\s+readOnly\s+onRemove=\{removeItem\}/
    );
    expect(sectionBody).not.toMatch(/onChangeDisplay/);
  });

  test("the display primitive is reached ONLY by the corner-resize handler", () => {
    // Its first and only caller writes a width percentage, and nothing else.
    // Details are pinned in templateSectionImageUx.test.js.
    expect(templateDoc.match(/setSectionPhotoDisplay/g)).toHaveLength(2); // import + call
    expect(templateDoc).toMatch(/const resizeSectionPhoto = useCallback\(/);
    expect(templateDoc).toMatch(/patch: \{ widthPct \}/);
  });
});
