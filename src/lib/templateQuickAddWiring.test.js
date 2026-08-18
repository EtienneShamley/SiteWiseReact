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
//   - where ONE capture goes (DOCUMENT | REFUSE):     templateSectionBody.test.js
//   - the shared editor registry the route opens:      sectionEditorRegistry.test.js
//   - what a destination may accept:                  quickAddTarget.test.js
//
// Since Phase G a Section capture is delivered ONLY through the document
// route: NoteTemplateDoc's `sectionDocQuickAddTarget(rowId)` answers
// `{ editor, active } | { refuse } | null`, and the two composer halves insert
// into that editor. There is no legacy `sectionContent` writer and no LEGACY
// branch anywhere on the path.
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
    // Phase F5: a modern Section DOES have a caret, so the same separator
    // Free-form uses between staged attachments is forwarded too — but it is
    // NoteTemplateDoc's decision (openSectionQuickAddSeparator) whether it
    // does anything; this file only reuses the composer contract, never
    // Free-form's OWN caret-capture machinery.
    expect(templateSend).toMatch(/openBlockAfterAttachment: \(\) => compose\.openBlockAfterAttachment\?\.\(rowId\)/);
    expect(templateSend).not.toMatch(/placeCaret|restoreFreeformInsertPoint/);
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

describe("Template Quick Add text becomes Section document content, never an answer", () => {
  test("a Template row routes its text through the composer", () => {
    expect(bottomBar).toMatch(
      /const textUsesComposer = target\?\.kind === QUICK_ADD_KIND\.TEMPLATE_ROW/
    );
    expect(bottomBar).toMatch(/textUsesComposer,/);
  });

  test("the text half inserts into the routed Section editor, through the answer boundary", () => {
    const appendText = between(
      templateDoc,
      "const appendComposedText = useCallback(",
      "const templateComposeApi"
    );
    expect(appendText).toMatch(/const target = sectionDocQuickAddTarget\(rowId\)/);
    // Sanitized through the EXISTING answer boundary — no HTML passed through.
    expect(appendText).toMatch(/const html = modelToHtml\(answerToModel\(value\)\)/);
    // ACTIVE: at the current selection. INACTIVE: at the end of the document.
    expect(appendText).toMatch(/editor\.chain\(\)\.insertContent\(html\)\.run\(\)/);
    expect(appendText).toMatch(
      /insertContentAt\(editor\.state\.doc\.content\.size, html\)/
    );
    // It has no answers channel at all, and no legacy section writer.
    expect(appendText).not.toMatch(/setRowText|rowTextRef\.current =|handleRightChange|appendTextToAnswer/);
    expect(appendText).not.toMatch(/persistCustomRows|handleCustomRowPatch/);
    expect(appendText).not.toMatch(/appendSectionText|persistSectionContent|sectionContent/);
  });

  test("the composer's microphone only opens the Live Transcript workspace — it records and sends nothing itself", () => {
    // 2026-08-18: the composer's private recorder is gone; the ONE
    // transcription session lives in LiveTranscriptProvider and inserts
    // through MainArea's shared paths (liveTranscriptWiring.test.js).
    const voice = between(bottomBar, "const handleVoiceClick", "const runRefine");
    expect(voice).toMatch(/onOpenLiveTranscript\(e\.currentTarget\)/);
    expect(voice).not.toMatch(/onSendComposer|handleSend|draftStoreRef|onInsertText|MediaRecorder|transcribeBlob|setInput\(|setRefinedDraft\(/);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The document route — ONE writer per row                                  */
/* -------------------------------------------------------------------------- */

describe("a Section capture goes through the document route only", () => {
  const routeFn = between(
    templateDoc,
    "const sectionDocQuickAddTarget = useCallback(",
    "const openSectionQuickAddSeparator"
  );
  const attach = between(
    templateDoc,
    "const appendComposedAttachment = useCallback(",
    "const appendComposedText"
  );
  const text = between(
    templateDoc,
    "const appendComposedText = useCallback(",
    "const templateComposeApi"
  );

  test("the route answers { refuse } | { editor, active } | null, and nothing else", () => {
    expect(routeFn).toMatch(/if \(!rowId \|\| !rowIsPresent\(rowId\)\) return null;/);
    expect(routeFn).toMatch(/route === SECTION_QUICK_ADD_ROUTE\.REFUSE/);
    expect(routeFn).toMatch(/return \{\s*refuse:/);
    expect(routeFn).toMatch(
      /return \{ editor, active: activeSectionRowIdRef\.current === rowId \}/
    );
    // No LEGACY route exists any more.
    expect(routeFn).not.toMatch(/SECTION_QUICK_ADD_ROUTE\.LEGACY|legacy:/);
    expect(templateDoc).not.toMatch(/SECTION_QUICK_ADD_ROUTE\.LEGACY/);
    expect(read("lib/templateSectionBody.js")).not.toMatch(/LEGACY: "legacy-section"|QUICK_ADD_ROUTE\.LEGACY/);
  });

  test("the route is the reader's verdict, published once per row", () => {
    expect(templateDoc).toMatch(/quickAdd\[row\.id\] = resolveSectionQuickAddRoute\(body\)/);
    expect(templateDoc).toMatch(/sectionQuickAddRouteRef\.current = sectionState\.quickAdd/);
    expect(routeFn).toMatch(/const route = sectionQuickAddRouteRef\.current\[rowId\]/);
  });

  test("a row with no editable entry opens an EMPTY document — nothing existed to lose", () => {
    expect(routeFn).toMatch(/const entry = sectionEditableRef\.current\[rowId\]/);
    expect(routeFn).toMatch(/html: entry \? entry\.html : ""/);
    expect(routeFn).toMatch(/registry\.getOrCreate\(identity, \{/);
    expect(routeFn).toMatch(/setSectionEditorLive\(rowId, true\)/);
  });

  test("opening the editor writes nothing — only the capture's own transaction persists", () => {
    // The document is supplied at construction; the ONE write path is the
    // editor's own update handler → persistSectionDoc.
    expect(routeFn).not.toMatch(/persist|saveInstanceConfirmed|saveNoteTemplateInstance/);
    expect(templateDoc).toMatch(/onUpdate: \(\{ editor \}\) =>\s*sectionDocUpdateRef\.current\?\.\(identity, context\?\.rowId, editor\)/);
    expect(templateDoc).toMatch(/const handleSectionDocUpdate = useCallback\(/);
    expect(templateDoc).toMatch(/persistSectionDoc\(rowId, html\)/);
  });

  test("BOTH composer halves take the route, and have NO legacy branch", () => {
    for (const half of [attach, text]) {
      expect(half).toMatch(/const target = sectionDocQuickAddTarget\(rowId\)/);
      expect(half).toMatch(/if \(!target \|\| !target\.editor\)/);
      expect(half).toMatch(/\(target && target\.refuse\)/);
      expect(half).not.toMatch(/appendSectionAttachment|appendSectionText/);
      expect(half).not.toMatch(/persistSectionContent|sectionMaterialisationFor|materialisation:/);
      expect(half).not.toMatch(/target\.legacy|route === SECTION_QUICK_ADD_ROUTE/);
    }
    // The legacy writers are not even imported.
    expect(templateDoc).not.toMatch(/from "\.\.\/\.\.\/lib\/templateSectionAttachments"/);
    expect(templateDoc).not.toMatch(/from "\.\.\/\.\.\/lib\/templateSectionText"/);
    expect(templateDoc).not.toMatch(/appendSectionAttachment|appendSectionText/);
    expect(mainArea).not.toMatch(/appendSectionAttachment|appendSectionText/);
  });

  test("the attachment half uses the SHARED insertion pipeline with the Template's own policy", () => {
    expect(attach).toMatch(/await insertLocalImageAsset\(/);
    expect(attach).toMatch(/await insertFreeformFileAttachment\(/);
    expect(attach).toMatch(/validate: validateComposedPhoto/);
    expect(attach).toMatch(/validate: validateSectionFile/);
    expect(attach).toMatch(/createPhotoAsset\(blob, options\?\.metadata, options\?\.name\)/);
    expect(attach).toMatch(/createNoteFileAsset\(blob, options\?\.metadata\)/);
    expect(attach).toMatch(/removeAsset: deleteAsset/);
    // ACTIVE inserts at the live selection; INACTIVE at the end of the document.
    expect(attach).toMatch(/const beforeInsert = target\.active\s*\?\s*undefined\s*:\s*\(\) => placeSectionCaretAtEnd\(editor\)/);
    // A stale result is forwarded, never reported as a per-field failure.
    expect(attach).toMatch(/if \(result\.stale\) return \{ ok: false, stale: true \}/);
  });

  test("the separator between staged items is a no-op unless the row is the ACTIVE Section", () => {
    const separator = between(
      templateDoc,
      "const openSectionQuickAddSeparator = useCallback(",
      "const validateSectionFile"
    );
    expect(separator).toMatch(/if \(!rowId \|\| activeSectionRowIdRef\.current !== rowId\) return;/);
    expect(separator).toMatch(/insertContentAt\(pos, \{ type: "paragraph" \}\)/);
    expect(templateDoc).toMatch(/openBlockAfterAttachment: openSectionQuickAddSeparator/);
  });

  test("the retired per-item session machinery is gone from NoteTemplateDoc", () => {
    for (const gone of [
      "activeTextRowId",
      "activeSectionItemId",
      "materializedSection",
      "handleSectionStructuralChange",
      "forgetRemovedSectionItems",
      "persistSectionContentHealed",
      "handleRowEditorChange",
      "removeSectionAttachment",
      "setSectionPhotoDisplay",
      "reorderSectionItem",
      "moveSectionItemIntoText",
      "handleRefineRow",
      "handleRevertRowRefine",
      "rowRefineBackups",
    ]) {
      expect(templateDoc).not.toContain(gone);
    }
    // MainArea passes only the Section-refine backup trio, and imports only the
    // generic backup-map helpers from templateRowRefine.
    expect(mainArea).toMatch(/sectionRefineBackups=\{sectionRefineBackups\}/);
    expect(mainArea).toMatch(/onSetSectionRefineBackup=\{/);
    expect(mainArea).toMatch(/onClearSectionRefineBackup=\{/);
    expect(mainArea).not.toMatch(/rowRefineBackups=|onSetRowRefineBackup|onClearRowRefineBackup/);
    expect(mainArea).toMatch(
      /import \{\s*clearRowRefineBackup,\s*pruneRowRefineBackups,\s*\} from "\.\.\/lib\/templateRowRefine"/
    );
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
    // And no frozen legacy list either — the ONE writer is the editor's own
    // update handler.
    expect(composeBlock).not.toMatch(/persistSectionContent|sectionContent/);
  });

  test("a structured row's typed value and a legacy Photo/File primary are never document content", () => {
    // The composers reach the instance only through the routed editor, whose
    // document the reader built WITHOUT the typed value / primary attachments
    // (`sectionReplacesRowAnswer` decides, once, in the reader).
    expect(composeBlock).not.toMatch(/rowTextRef|rowAttachmentsRef|customRowsRef/);
    const reader = withoutComments(read("lib/templateSectionBody.js"));
    expect(reader).toMatch(/const includeAnswer = sectionReplacesRowAnswer\(rowType, isAttachmentField\)/);
    expect(reader).toMatch(/answer: includeAnswer \? legacyAnswerFor\(source, rowId, isCustomRow\) : undefined/);
  });

  test("the section save carries answers/attachments/evidence through unchanged", () => {
    expect(templateDoc).toMatch(
      /const persistSectionDoc = useCallback\([\s\S]{0,600}?answers: rowTextRef\.current,[\s\S]{0,120}?attachments: rowAttachmentsRef\.current,[\s\S]{0,120}?evidence: rowEvidenceRef\.current,[\s\S]{0,160}?sectionDoc: setRowSectionDoc\(/
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

/* -------------------------------------------------------------------------- */
/* 7. Historical section photos: read-only compatibility rendering             */
/* -------------------------------------------------------------------------- */

describe("HISTORICAL READ COMPATIBILITY — a stored section photo the document cannot hold renders read-only", () => {
  const table = withoutComments(read("components/template/ResizableTwoColTable.js"));
  const compat = between(
    table,
    "function renderCompatSegmentBody",
    "function renderSectionDocSegment("
  );

  test("a compatibility photo renders with readOnly, no display toolbar and no Remove", () => {
    expect(compat).toMatch(/<PhotoAttachment attachment=\{entry\} readOnly \/>/);
    expect(compat).not.toMatch(/onChangeDisplay|onRemove/);
  });

  test("a document IMAGE segment of an owned row is pressable — it activates the shared editor", () => {
    const media = between(table, "function renderSectionDocMedia", "function renderSectionDocSegmentBody");
    expect(media).toMatch(/twocol-section-media--pressable/);
    expect(media).toMatch(/activateSectionEditor\(row, event\)/);
    expect(read("components/template/template.css")).toContain(".twocol-section-media--pressable");
  });

  test("PhotoAttachment has no move surface and no corner resize any more", () => {
    const photo = withoutComments(read("components/template/PhotoAttachment.js"));
    expect(photo).not.toMatch(/onMoveStart|onResizeWidth/);
    expect(photo).not.toMatch(/photo-att-corner|photo-att-img--movable|photo-att-frame--resizing/);
    expect(photo).toMatch(/readOnly/);
    expect(photo).toMatch(/onChangeDisplay/);
    // The retired per-item modules that fed it are gone.
    for (const gone of [
      "lib/templateSectionImageResize.js",
      "lib/templateSectionImageMove.js",
      "lib/templateSectionItemDragSession.js",
    ]) {
      expect(fs.existsSync(path.join(SRC, gone))).toBe(false);
    }
  });
});
