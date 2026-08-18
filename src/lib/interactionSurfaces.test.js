// src/lib/interactionSurfaces.test.js
//
// The facts about the interaction system that live in CSS and in JSX rather
// than in a function, and so cannot be reached by unit-testing a helper.
//
// Source-text assertions are used here for the job they do well (see
// docs/TESTING.md and the neighbouring exportViewOwnership.test.js): proving
// that a token is defined for BOTH themes, that an active state is derived from
// the application's real state rather than from hover or a local guess, and
// that a replaced treatment is genuinely gone rather than merely unused.
//
// The composition rules themselves are covered behaviourally in
// interactionStyles.test.js — this suite deliberately does not re-assert them.

import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every application source file. Test files are excluded — they necessarily
 *  name the things they assert about. Used to prove a render path was not
 *  missed, rather than assuming the components already known about are all. */
function allSourceFiles(dir = SRC, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allSourceFiles(full, found);
    else if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const navCss = read("styles/nav.css");
const navCssCode = navCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** The `:root` (light) and `.dark` blocks, without comments. */
function themeBlock(selector) {
  const match = navCssCode.match(
    new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([\\s\\S]*?)\\n\\}`)
  );
  if (!match) throw new Error(`No ${selector} block found in styles/nav.css`);
  return match[1];
}

const lightTokens = themeBlock(":root");
const darkTokens = themeBlock(".dark");

const sidebar = withoutComments(read("components/Sidebar.js"));
const middlePane = withoutComments(read("components/MiddlePane.js"));
const appJs = withoutComments(read("App.js"));
const pdfLibrary = withoutComments(read("components/PdfLibrary.js"));
const mainArea = withoutComments(read("components/MainArea.js"));
const editorToolbar = withoutComments(read("components/EditorToolbar.js"));
const exportMenu = withoutComments(read("components/editor/ExportMenu.js"));
const formattingControls = withoutComments(read("components/editor/FormattingControls.js"));
const threeDotMenu = withoutComments(read("components/ThreeDotMenu.js"));
const templateLibrary = withoutComments(read("components/template/TemplateLibrary.js"));
const templateBuilderModal = withoutComments(read("components/template/TemplateBuilderModal.js"));
const templateBuilderDoc = withoutComments(read("components/template/TemplateBuilderDoc.js"));

/* ------------------------------------------------------------------ tokens */

describe("interaction tokens are defined for both themes", () => {
  const REQUIRED = [
    "--nw-accent-bright",
    "--nw-nav-muted-text",
    "--nw-state-hover-text",
    "--nw-state-hover-bg",
    "--nw-state-hover-border",
    "--nw-nav-active-text",
    "--nw-nav-selected-bg",
    "--nw-nav-active-border",
    "--nw-nav-rail",
    "--nw-focus-ring",
    "--nw-state-disabled-text",
    "--nw-danger-text",
    "--nw-danger-hover-bg",
    "--nw-danger-hover-border",
  ];

  test.each(REQUIRED)("%s is defined in the light theme", (token) => {
    expect(lightTokens).toContain(`${token}:`);
  });

  test.each(REQUIRED)("%s is defined in the dark theme", (token) => {
    expect(darkTokens).toContain(`${token}:`);
  });
});

describe("the approved interaction accent values are used", () => {
  test("dark mode uses the brighter, denser turquoise", () => {
    expect(darkTokens).toContain("--nw-accent-bright: #2AE5F2");
    expect(darkTokens).toContain("--nw-nav-active-text: #2AE5F2");
    expect(darkTokens).toContain("--nw-nav-rail: #2AE5F2");
  });

  test("light mode uses the deeper, denser turquoise that stays readable", () => {
    // A lighter value could not hold contrast on a white surface, so light mode
    // gains its density downward rather than upward.
    expect(lightTokens).toContain("--nw-accent-bright: #0B6E78");
    expect(lightTokens).toContain("--nw-nav-active-text: #0B6E78");
    expect(lightTokens).toContain("--nw-nav-rail: #0B6E78");
  });

  test("the superseded interaction values are gone from the state tokens", () => {
    // #39DDE9 / #1F7F88 survive ONLY as the brand mark (asserted below).
    expect(lightTokens).not.toContain("--nw-nav-active-text: #1F7F88");
    expect(darkTokens).not.toContain("--nw-nav-active-text: #39DDE9");
    expect(navCssCode).not.toContain("rgba(57, 221, 233");
  });
});

describe("the brand-mark tokens are unchanged", () => {
  test.each([":root", ".dark"])("%s keeps the brand accents", (selector) => {
    const block = themeBlock(selector);
    expect(block).toContain("--nw-accent: #39DDE9");
    expect(block).toContain("--nw-accent-strong: #1F7F88");
  });

  test("the sidebar mark still renders from the brand tokens, not the interaction accent", () => {
    expect(sidebar).toContain("var(--nw-accent-strong)");
    expect(sidebar).toContain("var(--nw-accent)");
    expect(sidebar).not.toContain("var(--nw-accent-bright)");
  });
});

/* ------------------------------------------------------- theme hierarchies */

describe("hover is theme-appropriate", () => {
  test("dark mode hovers to white text", () => {
    expect(darkTokens).toContain("--nw-state-hover-text: #ffffff");
  });

  test("light mode hovers to dark ink, never white on a pale surface", () => {
    expect(lightTokens).toContain("--nw-state-hover-text: #0f172a");
    expect(lightTokens).not.toMatch(/--nw-state-hover-text:\s*#f{3,6}/i);
  });

  test("inactive text is muted grey in both themes", () => {
    expect(lightTokens).toContain("--nw-nav-muted-text: #64748b");
    expect(darkTokens).toContain("--nw-nav-muted-text: #94a3b8");
  });
});

describe("hover never impersonates selection", () => {
  test("the segmented control's hover no longer uses the active text colour", () => {
    // The defect: `.nw-seg:hover` previously set --nw-nav-active-text, so
    // hovering an unselected view looked exactly like selecting it.
    const segHover = navCssCode.match(/\.nw-seg:hover[^{]*\{([^}]*)\}/);
    expect(segHover).not.toBeNull();
    expect(segHover[1]).toContain("--nw-state-hover-text");
    expect(segHover[1]).not.toContain("--nw-nav-active-text");
  });

  test("every hover rule excludes its own active state", () => {
    for (const base of ["nw-nav-item", "nw-seg", "nw-action"]) {
      const rule = navCssCode.match(new RegExp(`\\.${base}:hover[^{]*\\{`));
      expect(rule).not.toBeNull();
      expect(rule[0]).toContain(":not(");
    }
  });
});

/* -------------------------------------------------------- geometry & motion */

describe("state changes cannot move anything", () => {
  test("every variant reserves its border at rest", () => {
    for (const base of ["nw-nav-item", "nw-seg", "nw-action", "nw-icon-btn"]) {
      const rule = navCssCode.match(new RegExp(`\\.${base}\\s*\\{([^}]*)\\}`));
      expect(rule).not.toBeNull();
      expect(rule[1]).toContain("border: 1px solid transparent");
    }
  });

  test("the navigation rail is reserved transparently", () => {
    const rule = navCssCode.match(/\.nw-nav-item\s*\{([^}]*)\}/);
    expect(rule[1]).toContain("border-left: 3px solid transparent");
  });

  test("transitions cover colour and border only — never a dimension", () => {
    const transitions = navCssCode.match(/transition:[^;]+;/g) || [];
    expect(transitions.length).toBeGreaterThan(0);
    for (const value of transitions) {
      if (value.includes("none")) continue;
      expect(value).not.toMatch(/\b(width|height|padding|margin|transform|top|left|font-size|all)\b/);
    }
  });

  test("font weight changes only on full-width navigation rows", () => {
    // A weight change on a segmented pill would alter its measured width.
    const segRules = navCssCode.match(/\.nw-seg[^{]*\{[^}]*\}/g) || [];
    for (const rule of segRules) expect(rule).not.toContain("font-weight: 6");
    expect(navCssCode).toMatch(/\.nw-nav-item--active[\s\S]*?font-weight: 600/);
  });
});

describe("motion and focus follow the approved rules", () => {
  test("reduced motion disables the transitions", () => {
    expect(navCssCode).toContain("@media (prefers-reduced-motion: reduce)");
    const block = navCssCode.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(block[1]).toContain("transition: none");
  });

  test("focus replaces the browser indicator rather than removing it", () => {
    const focus = navCssCode.match(/:focus-visible[\s\S]*?\{([^}]*)\}/);
    expect(focus[1]).toContain("outline: 2px solid var(--nw-focus-ring)");
    expect(focus[1]).toContain("outline-offset: 2px");
  });

  test("no converted surface suppresses focus with an unreplaced outline-none", () => {
    for (const source of [sidebar, middlePane, pdfLibrary, mainArea, editorToolbar, exportMenu]) {
      expect(source).not.toContain("focus-visible:outline-none");
    }
  });
});

/* ------------------------------------------------- active-state ownership */

describe("active state follows real application state", () => {
  test("the top-level workspace switch reads `workspace`", () => {
    expect(sidebar).toMatch(/active=\{workspace === "projects"\}/);
    expect(sidebar).toMatch(/active=\{workspace === "pdfs"\}/);
  });

  test("PDFs stays current for as long as the PDF workspace is open", () => {
    // It is the workspace value itself, so it cannot be cleared by opening a
    // PDF, returning to the library, or anything else inside that workspace.
    // The shared sidebar row renders aria-current="page" from `active`.
    expect(sidebar).toMatch(/active=\{workspace === "pdfs"\}\s*\n\s*current="page"/);
    expect(sidebar).toMatch(/aria-current=\{active \? current \|\| "true" : undefined\}/);
  });

  test("a project is current only while no folder inside it is selected", () => {
    expect(sidebar).toContain("activeProjectId === pid && !activeFolderId");
  });

  test("folders and notes read their own selection state", () => {
    expect(sidebar).toContain("activeFolderId === folder.id && activeProjectId === pid");
    expect(sidebar).toContain("currentNoteId === note.id");
    expect(middlePane).toContain("currentNoteId === note.id");
  });

  test("the note surfaces (sidebar) read the values that render them", () => {
    // Since 2026-08-18 the note view / note workspace switches live in the
    // left sidebar as ONE "This note" group; the current surface is derived
    // from the same two values MainArea renders from (src/lib/noteSurfaces.js).
    expect(sidebar).toMatch(/const currentSurface = currentNoteSurface\(\{\s*tab: noteWorkspaceTab,\s*layout: activeNoteView,\s*\}\);/);
    expect(sidebar).toContain("active={currentSurface === surface}");
    expect(mainArea).toContain("const activeTab = noteWorkspaceTab;");
    expect(mainArea).toContain('style={{ display: activeTab === "note" ? "block" : "none" }}');
    expect(mainArea).toContain('noteLayout === "template" ? "block" : "none"');
  });

  test("no active state is derived from hover, focus or the DOM", () => {
    for (const source of [sidebar, middlePane, pdfLibrary, mainArea, editorToolbar, exportMenu]) {
      expect(source).not.toMatch(/onMouseEnter[\s\S]{0,80}(setActive|Active\()/);
      expect(source).not.toContain("classList.contains(\"nw-");
      expect(source).not.toContain("querySelector(\".nw-");
    }
  });
});

describe("individual PDF-library rows carry no persistent active state", () => {
  test("no row is ever marked current", () => {
    // Opening a PDF replaces the whole list with the editor, so no row is on
    // screen to be current. No selection state is invented to style one.
    expect(pdfLibrary).not.toContain("nw-nav-item--active");
    expect(pdfLibrary).not.toMatch(/navItemClass\(\{[^}]*active:/);
  });

  test("no PDF selection state is read for styling", () => {
    expect(pdfLibrary).not.toMatch(/currentPdfId\s*===/);
  });
});

/* --------------------------------------------------------- action controls */

describe("actions are actions, not locations", () => {
  test("Export takes the open state from its own dropdown state", () => {
    expect(exportMenu).toMatch(/actionButtonClass\(\{\s*open,/);
    expect(exportMenu).toContain("busy: running");
  });

  test("Export keeps the menu semantics it genuinely has", () => {
    expect(exportMenu).toContain('aria-haspopup="menu"');
    expect(exportMenu).toContain("aria-expanded={open}");
    expect(exportMenu).toContain("aria-busy={running}");
  });

  test("Export closes its own open state when an export starts", () => {
    // So the turquoise cannot survive the menu it describes.
    expect(exportMenu).toContain("setOpen(false)");
  });

  test("Template Library takes the open state from its modal's own state", () => {
    // The trigger lives in the sidebar's Workspace group; the modal and its
    // open state live in App.js — the trigger reads that state, never a
    // click memory.
    expect(sidebar).toContain("open: templateLibraryOpen,");
    expect(appJs).toContain("const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false);");
    expect(appJs).toContain("onClose={() => setTemplateLibraryOpen(false)}");
  });

  test("Template Library announces a dialog and does not misuse aria-expanded", () => {
    // aria-expanded describes a control that expands a region it owns; an
    // ordinary dialog trigger does not. (The sidebar's own collapse control
    // DOES expand a region it owns — the sidebar — and is the one control in
    // that file allowed aria-expanded.)
    const trigger = sidebar.slice(sidebar.indexOf("onClick={onOpenTemplateLibrary}"), sidebar.indexOf("</button>", sidebar.indexOf("onClick={onOpenTemplateLibrary}")));
    expect(trigger).toContain('aria-haspopup="dialog"');
    expect(trigger).not.toContain("aria-expanded");
  });

  test("Refine reports busy honestly and never keeps an open state", () => {
    expect(mainArea).toContain("busy: refineLoading");
    expect(mainArea).toContain("aria-busy={refineLoading}");
    expect(mainArea).not.toMatch(/chipBtnCls\(\{[^}]*open:/);
  });

  test("Revert is disabled when there is nothing to revert and is not destructive", () => {
    expect(mainArea).toContain("disabled: !canRevertRefine({");
    expect(mainArea).not.toMatch(/chipBtnCls\(\{[^}]*danger:/);
  });

  test("primary calls to action no longer borrow the selected-tab class", () => {
    for (const source of [pdfLibrary, mainArea]) {
      expect(source).not.toContain("nw-seg nw-seg--active");
    }
    expect(pdfLibrary).toContain("primary: true");
    expect(mainArea).toContain("primary: true");
  });

  test("no action button is given aria-current", () => {
    // aria-current is for genuine navigation. An action is not a location.
    expect(editorToolbar).not.toContain("aria-current");
    expect(exportMenu).not.toContain("aria-current");
  });
});

describe("the left pane's utility controls are actions, not locations", () => {
  // + New Project, + New Folder and + New Note. (The former "Hide" control was
  // replaced 2026-08-18 by the sidebar's collapse-to-rail control, asserted in
  // applicationShell.test.js.)
  const UTILITY_HANDLERS = [
    ["New Project", "onClick={createProject}"],
    ["New Folder", "createFolder(activeProjectId)"],
    ["New Note", "onClick={createRootNote}"],
  ];

  test("all three use the shared action variant", () => {
    const uses = sidebar.match(/actionButtonClass\(\{ className: "px-[23] py-1 rounded text-(xs|sm)" \}\)/g);
    expect(uses).not.toBeNull();
    expect(uses).toHaveLength(3);
  });

  test("none carries a hardcoded idle, hover or text colour any more", () => {
    // This exact combination was the four utility buttons' shared class string.
    // (The separate control that restores a hidden sidebar is not one of these
    // four and is deliberately left alone.)
    expect(sidebar).not.toContain(
      "bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700"
    );
  });

  test("none emits an active-navigation or selected-tab class", () => {
    // They are actions: nothing here is ever the user's current location.
    // Matched by their own class strings, so the pane's restore control — an
    // action too, asserted separately below — is not counted among the four.
    const utilityCalls =
      sidebar.match(/actionButtonClass\(\{ className: "px-[23] py-1 rounded text-(?:xs|sm)" \}\)/g) || [];
    expect(utilityCalls.length).toBe(3);
    for (const call of utilityCalls) {
      expect(call).not.toContain("nw-nav-item");
      expect(call).not.toContain("nw-seg");
      expect(call).not.toContain("open:");
      expect(call).not.toContain("primary:");
    }
  });

  test("none is given aria-current", () => {
    // aria-current appears in this file only on the genuine navigation rows.
    const ariaCurrent = sidebar.match(/aria-current=\{[^}]*\}/g) || [];
    for (const attr of ariaCurrent) {
      // `active ? current || "true"` is the shared navigation row's own
      // derivation from real state (SidebarNavItem).
      expect(attr).toMatch(/active \? current|isRootFolderActive|isActive|isProjectActive|isFolderActive/);
    }
  });

  test("none can stay turquoise after activation", () => {
    // The only turquoise these can reach is `:active`, which the browser drops
    // the moment the press ends — there is no class to leave behind.
    expect(navCssCode).toMatch(/\.nw-action:active[^{]*\{/);
    expect(sidebar).not.toContain("nw-action--open");
    expect(sidebar).not.toContain("nw-action--primary");
    // The two `open:`s in the sidebar are Template Library (its modal's own
    // state, asserted above) and Live transcript (its workspace's own open
    // state) — never these utility controls.
    expect((sidebar.match(/open:/g) || []).length).toBe(2);
    expect(sidebar).toContain("open: liveTranscript.open,");
  });

  test.each(UTILITY_HANDLERS)("the %s handler is unchanged", (_label, handler) => {
    expect(sidebar).toContain(handler);
  });

  test("the New Folder branch still chooses project folder vs root folder", () => {
    expect(sidebar).toContain("if (activeProjectId && !activeFolderId)");
    expect(sidebar).toContain("createRootFolder()");
    expect(sidebar).toContain("setActiveSelection(null, fid)");
  });

  test("keyboard focus styling reaches them through the shared variant", () => {
    expect(navCssCode).toMatch(/\.nw-action:focus-visible/);
  });

  test("disabled styling stays genuine for the variant they use", () => {
    // No `disabled` prop is passed today (none of the four has an unavailable
    // state), but the variant must still carry real disabled semantics rather
    // than a look-alike, for whenever one gains it.
    const disabledRule = navCssCode.match(/\.nw-action:disabled,\s*\.nw-action\[aria-disabled="true"\]\s*\{([^}]*)\}/);
    expect(disabledRule).not.toBeNull();
    expect(disabledRule[1]).toContain("--nw-state-disabled-text");
    expect(disabledRule[1]).toContain("cursor: not-allowed");
  });
});

/* ------------------------------------------------ Template modal family */

describe("the Template Library and Builder share the interaction system", () => {
  test("the whole modal family is enumerated — no render path is assumed", () => {
    // Sidebar (Template Library action) -> App.js (TemplateBuilderModal) ->
    // TemplateLibrary (list) or TemplateBuilderDoc (editor). There is no
    // separate template sidebar and no three-dot menu in this family; every
    // action is a labelled button.
    expect(appJs).toContain("<TemplateBuilderModal");
    expect(sidebar).toContain("onClick={onOpenTemplateLibrary}");
    expect(editorToolbar).not.toContain("TemplateBuilderModal");
    expect(templateBuilderModal).toContain("TemplateLibrary");
    expect(templateBuilderModal).toContain("TemplateBuilderDoc");
    expect(templateLibrary).not.toContain("ThreeDotMenu");
  });

  test("Create template uses the primary action variant", () => {
    expect(templateLibrary).toMatch(/primaryBtnCls = actionButtonClass\(\{\s*primary: true/);
    expect(templateLibrary).toContain("className={primaryBtnCls} onClick={handleCreate}");
  });

  test("Submit template uses the primary action variant", () => {
    expect(templateBuilderDoc).toMatch(/actionButtonClass\(\{\s*primary: true/);
  });

  test.each([
    ["Edit", "onClick={() => onEditTemplate && onEditTemplate(tpl.id)}"],
    ["Rename", "onClick={() => handleRename(tpl)}"],
    ["Duplicate", "onClick={() => handleDuplicate(tpl)}"],
    ["Set as default", "onClick={() => handleSetDefault(tpl)}"],
  ])("%s uses the ordinary action variant", (_label, handler) => {
    const button = templateLibrary.match(
      new RegExp(`className=\\{btnCls\\}[^>]*${handler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    expect(button).not.toBeNull();
    expect(templateLibrary).toMatch(/const btnCls = actionButtonClass\(\{ className:/);
  });

  test("Edit takes no permanent active state — editing replaces this view", () => {
    expect(templateLibrary).not.toContain("nw-action--open");
    expect(templateBuilderModal).toContain("setEditingTemplateId(null)");
  });

  test("Delete template uses the destructive variant and no accent class", () => {
    expect(templateLibrary).toMatch(/dangerBtnCls = actionButtonClass\(\{\s*danger: true/);
    expect(templateLibrary).toContain("className={dangerBtnCls}");
    const dangerDecl = templateLibrary.match(/dangerBtnCls = actionButtonClass\(\{[^}]*\}/)[0];
    expect(dangerDecl).not.toContain("open:");
    expect(dangerDecl).not.toContain("primary:");
  });

  test("Back and Close use the shared text-labelled action variant", () => {
    expect(templateBuilderModal).toMatch(/const btnCls = actionButtonClass\(\{ className:/);
    expect(templateBuilderModal).toContain('aria-label="Back to Template Library"');
    expect(templateBuilderModal).toContain('aria-label="Close Template Library"');
    expect(templateBuilderModal).not.toContain("nw-nav-item");
    expect(templateBuilderModal).not.toContain("nw-seg");
  });

  test("template rows use the shared navigation variant", () => {
    expect(templateLibrary).toContain("navItemClass({");
    expect(templateLibrary).not.toContain("border border-gray-300 dark:border-gray-700 rounded-lg");
  });

  test("no row claims to be the current location while the list is open", () => {
    // Entering Edit replaces this whole view, so there is nothing a "selected"
    // row could mean. No row may take the active-navigation treatment.
    expect(templateLibrary).not.toContain("nw-nav-item--active");
    expect(templateLibrary).not.toMatch(/navItemClass\(\{[^}]*active:/);
    expect(templateLibrary).not.toContain("aria-current");
  });

  test("being the default is a status, not an active navigation state", () => {
    // The regression this pins: `active: isDefault` + aria-current, which
    // described a configuration property as the user's current location.
    expect(templateLibrary).toContain("const isDefault = tpl.id === defaultId;");
    expect(templateLibrary).not.toContain("active: isDefault");
    expect(templateLibrary).not.toContain("aria-current={isDefault");
  });

  test("every row gets the same ordinary row treatment", () => {
    const rowCalls = templateLibrary.match(/navItemClass\(\{[^}]*\}\)/g) || [];
    expect(rowCalls).toHaveLength(1);
    expect(rowCalls[0]).not.toContain("active");
  });

  test("the Default badge remains visible and identifies the default", () => {
    expect(templateLibrary).toContain("{isDefault && (");
    expect(templateLibrary).toContain("Default");
  });

  test("the Default badge is a status chip, never a control", () => {
    expect(templateLibrary).toContain("nw-status-chip");
    // A <span>, so it cannot be focused, pressed or mistaken for a tab.
    expect(templateLibrary).toMatch(/<span className="nw-status-chip[^"]*">\s*Default/);
    // And the chip carries no interaction states of its own.
    const chipRules = [...navCssCode.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map(([, selector]) => selector.trim())
      .filter((selector) => selector.includes("nw-status-chip"));
    expect(chipRules).toHaveLength(1);
    for (const selector of chipRules) {
      expect(selector).not.toMatch(/:hover|:focus|:active|:disabled/);
    }
  });

  test("the chip reuses the shared accent tokens, adding no new colour", () => {
    const chip = navCssCode.match(/\.nw-status-chip\s*\{([^}]*)\}/);
    expect(chip).not.toBeNull();
    expect(chip[1]).toContain("var(--nw-nav-active-text)");
    expect(chip[1]).toContain("var(--nw-nav-selected-bg)");
    expect(chip[1]).toContain("var(--nw-nav-active-border)");
    expect(chip[1]).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  test("Set as default is still absent for the already-default template", () => {
    // Never rendered as a disabled control that could read as a selected tab.
    expect(templateLibrary).toContain("{!isDefault && (");
  });

  test("changing the default moves the status only, not a selection", () => {
    // handleSetDefault writes the stored default and re-reads it; there is no
    // selection state to move, and none is introduced for styling.
    expect(templateLibrary).toContain("setDefaultTemplateId(tpl.id)");
    expect(templateLibrary).toContain("setDefaultId(getDefaultTemplateId())");
    expect(templateLibrary).not.toContain("selectedTemplateId");
    expect(templateLibrary).not.toMatch(/useState[^;]*selected/i);
  });

  test("every template action still names the template it acts on", () => {
    for (const verb of ["Edit", "Rename", "Duplicate", "Delete"]) {
      expect(templateLibrary).toContain(`aria-label={\`${verb} template \${tpl.name || "Untitled"}\`}`);
    }
  });

  test("the template handlers and their confirmation behaviour are unchanged", () => {
    expect(templateLibrary).toContain("createTemplate(");
    expect(templateLibrary).toContain("renameTemplate(tpl.id, name)");
    expect(templateLibrary).toContain("duplicateTemplate(tpl.id)");
    expect(templateLibrary).toContain("deleteTemplate(tpl.id)");
    expect(templateLibrary).toContain("setDefaultTemplateId(tpl.id)");
    // The native confirm is deliberately kept: styling must not remove it.
    expect(templateLibrary).toContain("window.confirm(message)");
  });

  test("modal open/close logic is unchanged", () => {
    expect(templateBuilderModal).toContain("if (!open) return null;");
    expect(templateBuilderModal).toContain("if (open) setEditingTemplateId(null);");
    expect(templateBuilderModal).toContain("onClick={onClose}");
  });

  test("versioning, branding and field editing are untouched by this change", () => {
    expect(templateBuilderDoc).toContain("publishTemplateVersion(templateId, definition)");
    expect(templateBuilderDoc).toContain("normalizeBranding(");
    expect(templateBuilderDoc).toContain("<ResizableTwoColTable");
  });
});

/* ------------------------------------------- Notes pane and restore controls */

describe("the Notes pane is one implementation, fully converted", () => {
  test("MiddlePane is the only component rendering the Notes pane", () => {
    // Guards the assumption: if an alternate/narrow/popup note list is ever
    // added, this fails rather than letting it keep the old styling.
    const noteListSources = allSourceFiles()
      .filter((file) => /\+ New Note/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .sort();
    expect(noteListSources).toEqual(["MiddlePane.js", "Sidebar.js"]);
  });

  test("Hide and + New Note are actions, not navigation", () => {
    expect(middlePane).toMatch(/actionButtonClass\(\{ className: "px-2 py-1 rounded-lg text-xs" \}\)/);
    expect(middlePane).toMatch(/actionButtonClass\(\{ className: "px-3 py-1 rounded-lg text-sm mb-2" \}\)/);
    const actionCalls = middlePane.match(/actionButtonClass\(\{[^}]*\}\)/g) || [];
    for (const call of actionCalls) {
      expect(call).not.toContain("primary:");
      expect(call).not.toContain("open:");
      expect(call).not.toContain("nw-nav-item");
      expect(call).not.toContain("nw-seg");
    }
  });

  test("+ New Note matches the hierarchy of the Sidebar's own New Note", () => {
    // Both ordinary actions — neither pane promotes its own "+ New Note" to a
    // primary CTA. (Sidebar does use the primary variant elsewhere now, for
    // the "Show notes" restore control — asserted in its own describe block.)
    expect(middlePane).toMatch(
      /actionButtonClass\(\{ className: "px-3 py-1 rounded-lg text-sm mb-2" \}\)\s*\}\s*onClick=\{onNewNote\}/
    );
    expect(sidebar).toMatch(
      /actionButtonClass\(\{ className: "px-3 py-1 rounded text-sm" \}\)\s*\}\s*onClick=\{createRootNote\}/
    );
  });

  test("note rows follow currentNoteId and nothing else", () => {
    expect(middlePane).toContain("const isActive = currentNoteId === note.id;");
    expect(middlePane).toContain("active: isActive");
    expect(middlePane).toContain('aria-current={isActive ? "true" : undefined}');
    // Derived per render from one value, so selecting another note cannot leave
    // the previous row active — there is no second place the state could live.
    expect(middlePane).not.toMatch(/useState[^;]*active/i);
  });

  test("three-dot triggers use the shared icon variant", () => {
    expect(middlePane).toContain("iconButtonClass({");
    expect(middlePane).not.toContain("hover:text-black dark:hover:text-white");
  });

  test("destructive note actions stay red", () => {
    expect(middlePane).toContain("danger: true");
    expect(threeDotMenu).toContain("danger: !!opt?.danger");
  });

  test("the Notes pane handlers are unchanged", () => {
    expect(middlePane).toContain("onClick={onHideMiddlePane}");
    expect(middlePane).toContain("onClick={onNewNote}");
    expect(middlePane).toContain("onClick={() => setCurrentNoteId(note.id)}");
    expect(middlePane).toContain("renameNote(activeFolderId, note.id)");
    expect(middlePane).toContain("deleteNote(activeFolderId, note.id)");
  });
});

describe("the Sidebar's own hidden-pane restore control", () => {
  test("is replaced by the collapse-to-rail control — the whole pane is never hidden without a visible way back", () => {
    // 2026-08-18: the "Hide" + floating "Projects" restore pair is gone; the
    // sidebar collapses to an icon rail whose expand control is always
    // visible (asserted in detail in applicationShell.test.js).
    expect(sidebar).not.toContain('className: "fixed top-2 left-2 px-2 py-1 rounded z-50"');
    expect(sidebar).not.toContain("setHidden(");
    expect(sidebar).toContain("onClick={onToggleCollapsed}");
  });

  test("does not keep the old filled-grey utility styling", () => {
    expect(sidebar).not.toContain("bg-gray-200 dark:bg-gray-800");
  });

  test("focus and pressed styling reach it through the shared variant", () => {
    expect(navCssCode).toMatch(/\.nw-action:focus-visible/);
    expect(navCssCode).toMatch(/\.nw-action:active[^{]*\{/);
  });
});

describe("the Notes-pane restore control ('Show notes') lives in the Sidebar header", () => {
  test("MiddlePane owns no restore control of its own", () => {
    // The old fixed-position floating button is gone entirely — MiddlePane
    // renders nothing while collapsed, rather than a button of its own.
    expect(middlePane).not.toContain("fixed top-4 left-32");
    expect(middlePane).not.toMatch(/>\s*Notes\s*<\/button>/);
    expect(middlePane).toContain("if (middlePaneHidden) return null;");
  });

  test("App.js owns middlePaneHidden and passes it, and the handlers, to both panes", () => {
    // Sidebar and MiddlePane are siblings with no shared context for this —
    // App.js is the lowest common owner, and the state is transient only.
    expect(appJs).toContain(
      "const [middlePaneHidden, setMiddlePaneHidden] = useState(false);"
    );
    expect(appJs).toMatch(/<Sidebar\s+middlePaneHidden=\{middlePaneHidden\}\s+onShowMiddlePane=\{\(\) => setMiddlePaneHidden\(false\)\}/);
    expect(appJs).toMatch(/<MiddlePane\s+middlePaneHidden=\{middlePaneHidden\}\s+onHideMiddlePane=\{\(\) => setMiddlePaneHidden\(true\)\}/);
  });

  test("Sidebar receives the state and handler as props, not from AppStateContext", () => {
    expect(sidebar).toMatch(
      /export default function Sidebar\(\{\s*middlePaneHidden,\s*onShowMiddlePane,/
    );
    const destructure = sidebar.match(/const \{([\s\S]*?)\} = useAppState\(\);/);
    expect(destructure).not.toBeNull();
    expect(destructure[1]).not.toContain("middlePaneHidden");
    expect(destructure[1]).not.toContain("onShowMiddlePane");
  });

  test("MiddlePane receives the state and handler as props, not from AppStateContext", () => {
    expect(middlePane).toContain(
      "export default function MiddlePane({ middlePaneHidden, onHideMiddlePane }) {"
    );
    const destructure = middlePane.match(/const \{([\s\S]*?)\} = useAppState\(\);/);
    expect(destructure).not.toBeNull();
    expect(destructure[1]).not.toContain("middlePaneHidden");
    expect(destructure[1]).not.toContain("onHideMiddlePane");
  });

  test("visible label, accessible name and tooltip are exact", () => {
    expect(sidebar).toMatch(/>\s*Show notes\s*</);
    expect(sidebar).toContain('aria-label="Open notes pane"');
    expect(sidebar).toContain('title="Open notes pane"');
  });

  test("appears only under the exact conditions the Middle Pane itself renders under", () => {
    expect(sidebar).toContain(
      'workspace === "projects" && activeFolderId && middlePaneHidden &&'
    );
  });

  test("clicking it calls the App-owned restore handler", () => {
    expect(sidebar).toContain("onClick={onShowMiddlePane}");
  });

  test("uses the shared turquoise primary/highlighted variant, not a one-off colour", () => {
    const call = sidebar.match(/actionButtonClass\(\{\s*primary: true,[\s\S]*?\}\)/);
    expect(call).not.toBeNull();
    expect(call[0]).toContain("shrink-0");
  });

  test("layout is owned by flex/margin, not fixed or absolute coordinates", () => {
    const call = sidebar.match(/actionButtonClass\(\{\s*primary: true,[\s\S]*?\}\)/)[0];
    expect(call).not.toMatch(/\bfixed\b/);
    expect(call).not.toMatch(/\babsolute\b/);
    expect(call).not.toMatch(/\btop-\d/);
    expect(call).not.toMatch(/\bleft-\d/);
    expect(call).not.toMatch(/\bright-\d/);
    expect(call).not.toMatch(/-m[lrtb]?-\d/); // no negative margins
  });

  test("the Sidebar's expanded width is unchanged (w-64) and the rail is narrower", () => {
    expect(sidebar).toContain('SIDEBAR_EXPANDED_WIDTH_CLASS = "w-64"');
    expect(sidebar).toContain('SIDEBAR_RAIL_WIDTH_CLASS = "w-14"');
  });

  test("focus and pressed styling reach it through the shared variant", () => {
    expect(navCssCode).toMatch(/\.nw-action:focus-visible/);
    expect(navCssCode).toMatch(/\.nw-action--primary\s*\{/);
    expect(navCssCode).toMatch(/\.nw-action--primary:hover:not\(:disabled\)/);
  });
});

describe("no new styling system was introduced", () => {
  const CONVERTED_THIS_PASS = {
    "TemplateLibrary.js": templateLibrary,
    "TemplateBuilderModal.js": templateBuilderModal,
    "TemplateBuilderDoc.js": templateBuilderDoc,
    "MiddlePane.js": middlePane,
    "Sidebar.js": sidebar,
  };

  test.each(Object.entries(CONVERTED_THIS_PASS))(
    "%s introduces no hard-coded turquoise value",
    (_name, source) => {
      expect(source).not.toMatch(/#2AE5F2|#0B6E78|#39DDE9|#40E0D0|#00C9A7/i);
      // The brand mark's two tokens are the only accent references allowed, and
      // only in Sidebar.
      const accentVars = source.match(/var\(--nw-[a-z-]*accent[a-z-]*\)/g) || [];
      for (const usage of accentVars) {
        expect(["var(--nw-accent)", "var(--nw-accent-strong)"]).toContain(usage);
      }
    }
  );

  test.each(Object.entries(CONVERTED_THIS_PASS))(
    "%s drops the old filled-grey button utilities",
    (_name, source) => {
      expect(source).not.toContain("hover:bg-gray-200 dark:hover:bg-neutral-700");
      expect(source).not.toContain("hover:bg-gray-300 dark:hover:bg-gray-700");
      expect(source).not.toContain("bg-white dark:bg-neutral-800");
    }
  );

  test("every converted surface composes through the shared helpers only", () => {
    for (const source of Object.values(CONVERTED_THIS_PASS)) {
      const rawVariants = source.match(/"[^"]*nw-(action|nav-item|seg|icon-btn|menu-item)[^"]*"/g) || [];
      expect(rawVariants).toEqual([]);
    }
  });
});

describe("the pressed state is temporary by construction", () => {
  test("it is a :active rule, never a class the component can leave behind", () => {
    const rule = navCssCode.match(/\.nw-action:active[^{]*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule[1]).toContain("--nw-nav-active-text");
  });

  test("a disabled control cannot show the pressed state", () => {
    const selector = navCssCode.match(/\.nw-action:active[^{]*\{/)[0];
    expect(selector).toContain(":not(:disabled)");
    expect(selector).toContain(':not([aria-disabled="true"])');
  });

  test("a destructive control stays red while being pressed", () => {
    expect(navCssCode.match(/\.nw-action:active[^{]*\{/)[0]).toContain(
      ":not(.nw-action--danger)"
    );
  });
});

describe("the note surfaces are sidebar navigation, not tabs", () => {
  test("they are labelled navigation groups with aria-current — no aria-pressed toggles above the document remain", () => {
    // 2026-08-18: the "Note view" / "Note workspace" segmented groups above the
    // document were replaced by the sidebar's "This note" navigation group.
    expect(sidebar).toContain('aria-label="This note"');
    expect(sidebar).toContain('aria-label="Workspace"');
    expect(mainArea).not.toContain('aria-label="Note view"');
    expect(mainArea).not.toContain('aria-label="Note workspace"');
    expect(mainArea).not.toContain("aria-pressed={activeTab");
  });

  test("they are not converted to an ARIA tablist by this feature", () => {
    for (const source of [mainArea, sidebar]) {
      expect(source).not.toContain('role="tablist"');
      expect(source).not.toContain('role="tab"');
      expect(source).not.toContain("aria-selected");
    }
  });
});

/* --------------------------------------------------- formatting foundation */

describe("the formatting toolbar takes the foundation but keeps its own colours", () => {
  test("it uses the shared icon-button foundation", () => {
    expect(formattingControls).toContain("iconButtonClass({");
    expect(formattingControls).toContain("nw-focusable");
  });

  test("it no longer carries its own hover, focus and disabled treatment", () => {
    expect(formattingControls).not.toContain("hover:text-gray-900 dark:hover:text-white");
    expect(formattingControls).not.toContain("focus-visible:ring-blue-400/60");
  });

  test("the per-format active colours survive", () => {
    // Bold, headings, code, task lists and highlight stay distinguishable from
    // one another; unifying them into one turquoise would remove information.
    for (const colour of [
      "text-blue-600",
      "text-purple-600",
      "text-yellow-600",
      "text-green-600",
      "bg-yellow-300",
    ]) {
      expect(formattingControls).toContain(colour);
    }
  });

  test("an active format opts out of the shared hover so its colour survives", () => {
    expect(formattingControls).toContain("nw-icon-btn--own-active");
    expect(navCssCode).toContain(":not(.nw-icon-btn--own-active)");
  });

  test("the idle icon-button colours are withheld from an own-active control", () => {
    // styles/nav.css is imported after Tailwind's utilities, so an
    // unconditional `color` on `.nw-icon-btn` would OUTRANK `text-blue-600` on
    // the same element and repaint every active format in the muted grey. The
    // idle colours must therefore stay behind the `--own-active` exclusion.
    const base = navCssCode.match(/\.nw-icon-btn\s*\{([^}]*)\}/);
    expect(base).not.toBeNull();
    expect(base[1]).not.toContain("color:");

    const idle = navCssCode.match(
      /\.nw-icon-btn:not\(\.nw-icon-btn--own-active\)[^{]*\{([^}]*)\}/
    );
    expect(idle).not.toBeNull();
    expect(idle[1]).toContain("color: var(--nw-nav-muted-text)");
  });

  test("the pressed and danger icon rules outrank that scoped idle rule", () => {
    // A single-class selector would lose to `.nw-icon-btn:not(…)`.
    expect(navCssCode).toContain(".nw-icon-btn.nw-icon-btn--pressed");
    expect(navCssCode).toContain(".nw-icon-btn.nw-icon-btn--danger");
  });

  test("no formatting control is recoloured to the interaction accent", () => {
    expect(formattingControls).not.toContain("nw-icon-btn--pressed");
    expect(formattingControls).not.toContain("nw-action--open");
  });
});

/* ------------------------------------------------------------- destructive */

describe("destructive controls stay red", () => {
  test("the three-dot menu routes destructive rows through the danger variant", () => {
    expect(threeDotMenu).toContain("danger: !!opt?.danger");
  });

  test("destructive rows are not given the accent variants", () => {
    expect(threeDotMenu).not.toContain("nw-action--open");
    expect(threeDotMenu).not.toContain("nw-nav-item--active");
  });

  test("the danger rules never reference the interaction accent", () => {
    // Rules that TARGET danger. `:not()` is stripped from the selector first,
    // so the `:active` rule that merely EXCLUDES danger is not mistaken for one.
    const dangerRules = [...navCssCode.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map(([, selector, body]) => ({ selector: selector.trim(), body }))
      .filter(({ selector }) => selector.replace(/:not\([^)]*\)/g, "").includes("--danger"));

    expect(dangerRules.length).toBeGreaterThan(0);
    for (const { body } of dangerRules) {
      expect(body).not.toContain("--nw-nav-active-text");
      expect(body).not.toContain("--nw-accent-bright");
      expect(body).not.toContain("--nw-nav-selected-bg");
    }
  });

  test("destructive hover keeps a red surface rather than the shared one", () => {
    expect(navCssCode).toMatch(/\.nw-action--danger:hover[^{]*\{[^}]*--nw-danger-hover-bg/);
  });
});

/* ---------------------------------------------- no obsolete values remain */

describe("the replaced treatments are gone from the converted surfaces", () => {
  const CONVERTED = {
    "Sidebar.js": sidebar,
    "MiddlePane.js": middlePane,
    "PdfLibrary.js": pdfLibrary,
    "EditorToolbar.js": editorToolbar,
    "ExportMenu.js": exportMenu,
  };

  test.each(Object.entries(CONVERTED))(
    "%s hardcodes no hover, focus or selection colour",
    (_name, source) => {
      expect(source).not.toContain("focus-visible:ring-blue");
      expect(source).not.toContain("hover:text-black dark:hover:text-white");
      expect(source).not.toContain("nw-seg--active");
    }
  );

  test("the sidebar's per-theme three-dot branch is gone", () => {
    // It duplicated in JavaScript what the token layer now states once.
    expect(sidebar).not.toContain("dotColor");
    expect(sidebar).not.toContain("hover:bg-gray-200 active:bg-gray-300");
  });

  test("the retired hover token is kept as an alias, not silently deleted", () => {
    // Anything not yet migrated must not lose its hover treatment.
    expect(lightTokens).toContain("--nw-nav-hover-bg: var(--nw-state-hover-bg)");
    expect(darkTokens).toContain("--nw-nav-hover-bg: var(--nw-state-hover-bg)");
  });
});
