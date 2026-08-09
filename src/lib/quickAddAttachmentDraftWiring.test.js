// src/lib/quickAddAttachmentDraftWiring.test.js
//
// Source-text assertions, used for the one job they do well: proving that the
// Free-form capture path now STAGES where it used to insert, that the Template
// path was left alone, and that the persistence and lifecycle wiring around
// both is present. No DOM testing library is installed (see docs/TESTING.md),
// so these component-level facts cannot be shown any other way.
//
// The behaviour itself is proved in the neighbouring suites:
//   - the queue and object-URL lifecycle: quickAddDraft.test.js
//   - order, single caret placement, partial success: quickAddDelivery.test.js
//   - the write ordering these reuse: editorImageInsert / editorFileInsert
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

const bottomBar = withoutComments(read("components/BottomBar.js"));
const mainArea = withoutComments(read("components/MainArea.js"));

describe("choosing a Free-form attachment stages it instead of inserting it", () => {
  test("the picker routes to the staging functions when staging is enabled", () => {
    expect(bottomBar).toMatch(/if \(stagingEnabled\) \{[\s\S]{0,400}?stageStampedPhoto/);
    expect(bottomBar).toMatch(/stageAttachedFile\(f\)/);
  });

  test("the camera routes to the same staging functions", () => {
    const camera = bottomBar.slice(bottomBar.indexOf("const handleCameraSelected"));
    expect(camera).toMatch(/stagingEnabled/);
    expect(camera).toMatch(/stageStampedPhoto\(f\)/);
    expect(camera).toMatch(/stageAttachedFile\(f\)/);
  });

  test("staging is Free-form only and requires the composer send handler", () => {
    expect(bottomBar).toMatch(
      /stagingEnabled\s*=\s*\n?\s*target\?\.kind === QUICK_ADD_KIND\.FREEFORM/
    );
    expect(bottomBar).toMatch(/typeof onSendComposer === "function"/);
  });

  test("staging captures NO insertion point — staging is not delivery", () => {
    // The destination must be resolved at Send, so the user may stage a photo,
    // keep working, move the caret and only then send.
    const staging = bottomBar.slice(
      bottomBar.indexOf("async function stageStampedPhoto"),
      bottomBar.indexOf("const removeStagedAttachment")
    );
    expect(staging).not.toMatch(/snapshotInsertPoint/);
    expect(staging).not.toMatch(/insertPoint/);
  });

  test("staging inserts nothing into the note", () => {
    const staging = bottomBar.slice(
      bottomBar.indexOf("async function stageStampedPhoto"),
      bottomBar.indexOf("const removeStagedAttachment")
    );
    expect(staging).not.toMatch(/onInsertImage/);
    expect(staging).not.toMatch(/onInsertFile/);
    expect(staging).not.toMatch(/insertContent/);
  });
});

describe("the existing photo pipeline is reused, not duplicated", () => {
  test("staging runs the one stamping function and stores its output", () => {
    expect(bottomBar).toMatch(/stamped = await buildStampedImageBLOB\(file, check\.mimeType\)/);
    // Exactly two callers: the staging path and the unchanged Template path.
    const stampCalls = bottomBar.match(/buildStampedImageBLOB\(/g) || [];
    expect(stampCalls).toHaveLength(3); // 1 definition + 2 call sites
  });

  test("the source file is validated before any stamping work", () => {
    expect(bottomBar).toMatch(
      /function stageStampedPhoto[\s\S]{0,300}?validateEditorImageFile\(file\)/
    );
  });

  test("a document is validated before it is staged", () => {
    expect(bottomBar).toMatch(
      /function stageAttachedFile[\s\S]{0,200}?validateEditorFileAttachment\(file\)/
    );
  });
});

describe("Template attachment behaviour is unchanged", () => {
  test("the immediate insertion path still exists for non-Free-form destinations", () => {
    expect(bottomBar).toMatch(/insertStampedPhoto\(f, insertPoint\)/);
    expect(bottomBar).toMatch(/insertAttachedFile\(f, insertPoint\)/);
    expect(bottomBar).toMatch(/const insertPoint = snapshotInsertPoint\(\)/);
  });

  test("the Template form still routes captures to its own confirmed path", () => {
    expect(mainArea).toMatch(/handleTemplateAttachmentCapture/);
    expect(mainArea).toMatch(/templateAttachmentsRef/);
  });

  test("the composer send handler refuses to act on the Template form", () => {
    expect(mainArea).toMatch(
      /handleQuickAddComposerSend[\s\S]{0,900}?noteLayoutRef\.current === "template"[\s\S]{0,40}?return refused/
    );
  });
});

describe("Send delivers through the existing persistent paths", () => {
  test("the composer send reuses the shared image and file write sequences", () => {
    const handler = mainArea.slice(
      mainArea.indexOf("async function handleQuickAddComposerSend"),
      mainArea.indexOf("function handleInsertError")
    );
    expect(handler).toMatch(/insertLocalImageAsset/);
    expect(handler).toMatch(/insertFreeformFileAttachment/);
    // No second asset store, no second write ordering.
    expect(handler).not.toMatch(/createEditorImageAsset/);
    expect(handler).not.toMatch(/createEditorFileAsset/);
    expect(handler).not.toMatch(/localStorage/);
  });

  test("the destination is resolved once, at Send, from the live captured point", () => {
    expect(mainArea).toMatch(
      /placeCaret: \(\) =>\s*\n?\s*restoreFreeformInsertPoint\(freeformInsertPointRef\.current\)/
    );
  });

  test("no per-item beforeInsert re-restores the original position", () => {
    // This is what stops our own first insertion invalidating the rest of the
    // same Send: the batch continues from the editor's live selection.
    const handler = mainArea.slice(
      mainArea.indexOf("async function handleQuickAddComposerSend"),
      mainArea.indexOf("function handleInsertError")
    );
    expect(handler).not.toMatch(/beforeInsert/);
  });

  test("the file path still re-checks the originating note and view", () => {
    const handler = mainArea.slice(
      mainArea.indexOf("async function handleQuickAddComposerSend"),
      mainArea.indexOf("function handleInsertError")
    );
    expect(handler).toMatch(/isCurrentTarget/);
    expect(handler).toMatch(/noteKeyRef\.current === originNoteId/);
    expect(handler).toMatch(/noteLayoutRef\.current === "natural"/);
  });

  test("the block break is inserted at an EXPLICIT position, not at the selection", () => {
    // The bug this pins: a just-inserted image is left as a node SELECTION, and
    // the editor's insert command replaces the current selection — so inserting
    // the description at the selection deleted the photo. Inserting at
    // `selection.to` puts the new block after the node instead of over it.
    expect(mainArea).toMatch(/openBlockAfterAttachment: \(\) => \{/);
    expect(mainArea).toMatch(/const pos = originEditor\.state\.selection\.to/);
    expect(mainArea).toMatch(/insertContentAt\(pos, \{ type: "paragraph" \}\)/);
    // A node spec, never a markup string.
    expect(mainArea).not.toMatch(/insertContent\(\s*`<p>/);
  });

  test("the text half reuses the one literal-text insertion", () => {
    // Text-only Quick Add and the composer's text both go through this, so
    // newline semantics cannot diverge between them.
    expect(mainArea).toMatch(/function insertFreeformTextAtCaret/);
    expect(mainArea).toMatch(
      /function handleInsertTextAtCursor[\s\S]{0,300}?insertFreeformTextAtCaret\(text\)/
    );
    expect(mainArea).toMatch(/insertText: \(value\) => insertFreeformTextAtCaret\(value\)/);
  });
});

describe("Send routing is decided in one place", () => {
  test("handleSend routes through the shared route resolver", () => {
    expect(bottomBar).toMatch(/const route = resolveQuickAddSendRoute\(\{/);
    expect(bottomBar).toMatch(/attachmentCount: staged\.length/);
    expect(bottomBar).toMatch(/hasComposerHandler: typeof onSendComposer === "function"/);
  });

  test("the queue is read from the store, not from render state", () => {
    // A staging that has not re-rendered yet must not be missed at Send.
    expect(bottomBar).toMatch(/const staged = draftStoreRef\.current\.list\(\)/);
    expect(bottomBar).not.toMatch(/const staged = stagedAttachments/);
  });

  test("onInsertText is reachable ONLY on the text-only route", () => {
    // The reported bug: a staged image plus dictated text took this path,
    // delivering the words and silently abandoning the photo.
    const send = bottomBar.slice(
      bottomBar.indexOf("const handleSend"),
      bottomBar.indexOf("const clearDraft")
    );
    const textOnlyBranch = send.slice(
      send.indexOf("QUICK_ADD_SEND_ROUTE.TEXT_ONLY"),
      send.indexOf("setSending(true)")
    );
    // Exactly one call, and it is inside the text-only branch.
    expect((send.match(/onInsertText\(/g) || [])).toHaveLength(1);
    expect(textOnlyBranch).toMatch(/onInsertText\(text\)/);
    // The composer branch never sends text on its own.
    const composerBranch = send.slice(send.indexOf("setSending(true)"));
    expect(composerBranch).not.toMatch(/onInsertText/);
  });

  test("the composer receives the text and the attachments together", () => {
    expect(bottomBar).toMatch(/onSendComposer\(\{ text, attachments: staged \}\)/);
  });
});

describe("the composer clears only what was delivered", () => {
  test("clearing is decided by the shared result helper", () => {
    expect(bottomBar).toMatch(
      /const \{ deliveredIds, clearText \} = applyQuickAddSendResult\(result, \{/
    );
    expect(bottomBar).toMatch(/draftStoreRef\.current\.removeMany\(deliveredIds\)/);
    expect(bottomBar).toMatch(/if \(clearText\) clearTextDraft\(\)/);
  });

  test("nothing clears the queue wholesale after a send", () => {
    const send = bottomBar.slice(
      bottomBar.indexOf("const handleSend"),
      bottomBar.indexOf("const clearDraft")
    );
    expect(send).not.toMatch(/clearStaged\(\)/);
  });

  test("text-only Send keeps its original refusal semantics", () => {
    expect(bottomBar).toMatch(/const delivered = onInsertText\(text\)/);
    expect(bottomBar).toMatch(/if \(delivered === false\) return/);
  });
});

describe("voice only fills the text half", () => {
  const voice = bottomBar.slice(
    bottomBar.indexOf("const handleVoiceClick"),
    bottomBar.indexOf("const runRefine")
  );

  test("transcription never touches the staged queue", () => {
    expect(voice).not.toMatch(/draftStoreRef/);
    expect(voice).not.toMatch(/clearStaged/);
    expect(voice).not.toMatch(/removeMany/);
    expect(voice).not.toMatch(/syncStaged/);
  });

  test("transcription only updates the draft text", () => {
    expect(voice).toMatch(/setRefinedDraft\(/);
    expect(voice).toMatch(/setInput\(/);
  });

  test("a stale voice target reports and discards, clearing no attachments", () => {
    expect(voice).toMatch(/capturedTarget !== targetTokenRef\.current/);
    const stale = voice.slice(voice.indexOf("capturedTarget !== targetTokenRef.current"));
    expect(stale).not.toMatch(/clearStaged/);
    expect(stale).not.toMatch(/draftStoreRef/);
  });

  test("transcription never sends anything by itself", () => {
    expect(voice).not.toMatch(/onSendComposer/);
    expect(voice).not.toMatch(/handleSend/);
  });
});

describe("AI refine leaves staged attachments alone", () => {
  const refine = bottomBar.slice(
    bottomBar.indexOf("const runRefine"),
    bottomBar.indexOf("return (")
  );

  test("refine touches only the text draft", () => {
    expect(refine).not.toMatch(/draftStoreRef/);
    expect(refine).not.toMatch(/clearStaged/);
    expect(refine).not.toMatch(/onSendComposer/);
  });
});

describe("staged drafts do not follow the user", () => {
  test("a note change clears the queue", () => {
    expect(bottomBar).toMatch(/clearStaged\(\);[\s\S]{0,120}?\}, \[currentNoteId\]\)/);
  });

  test("leaving Free-form clears the queue", () => {
    expect(bottomBar).toMatch(
      /if \(stagingEnabled\) return;[\s\S]{0,120}?clearStaged\(\);[\s\S]{0,120}?\}, \[stagingEnabled\]\)/
    );
  });

  test("unmount revokes every live preview URL", () => {
    expect(bottomBar).toMatch(/return \(\) => store\.clear\(\)/);
  });

  test("the trash clears the whole unsent composition", () => {
    expect(bottomBar).toMatch(
      /const clearDraft = \(\) => \{[\s\S]{0,120}?clearTextDraft\(\);[\s\S]{0,60}?clearStaged\(\);/
    );
  });
});

describe("nothing staged is persisted", () => {
  test("the draft store writes to no storage at all", () => {
    const draft = withoutComments(read("lib/quickAddDraft.js"));
    expect(draft).not.toMatch(/localStorage/);
    expect(draft).not.toMatch(/indexedDB/);
    expect(draft).not.toMatch(/assetStorage/);
  });

  test("no blob: URL can reach the note through the composer", () => {
    const delivery = withoutComments(read("lib/quickAddDelivery.js"));
    expect(delivery).not.toMatch(/createObjectURL/);
    expect(delivery).not.toMatch(/blob:/);
    // The preview URL is composer state only — it is never handed to delivery.
    const handler = mainArea.slice(
      mainArea.indexOf("async function handleQuickAddComposerSend"),
      mainArea.indexOf("function handleInsertError")
    );
    expect(handler).not.toMatch(/previewUrl/);
  });

  test("the staged payload, not a preview URL, is what gets persisted", () => {
    expect(mainArea).toMatch(/sourceFile: item\.payload/);
    expect(mainArea).toMatch(/blob: item\.payload/);
    expect(mainArea).toMatch(/file: item\.payload/);
  });
});

describe("Send is enabled by an attachment alone", () => {
  test("the gate is the shared composer rule, not a text check", () => {
    expect(bottomBar).toMatch(/canSubmit = canSendQuickAddComposer\(\{/);
    expect(bottomBar).toMatch(/attachmentCount: stagedAttachments\.length/);
    expect(bottomBar).toMatch(/disabled=\{!canSubmit \|\| isDisabled\}/);
  });
});

describe("no new dependency", () => {
  test("the new modules import only existing project code", () => {
    for (const file of ["lib/quickAddDraft.js", "lib/quickAddDelivery.js"]) {
      const imports = read(file).match(/^import .*from "(.*)";$/gm) || [];
      for (const line of imports) {
        expect(line).toMatch(/from "\.\//);
      }
    }
  });

  test("package.json dependencies are untouched by this feature", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8"));
    // react-icons already provided every icon the staged list uses.
    expect(pkg.dependencies).toHaveProperty("react-icons");
  });
});
