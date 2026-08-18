// src/lib/notesPaneRail.test.js
//
// THE COLLAPSED NOTES RAIL: when a note count is honest, how it is worded and
// capped, and that it is derived from the pane's own canonical collection
// rather than tracked separately.
import fs from "fs";
import path from "path";
import {
  NOTE_COUNT_DISPLAY_CAP,
  formatNoteCount,
  notesRailCount,
  notesRailRestoreLabel,
} from "./notesPaneRail";

const SRC = path.join(__dirname, "..");
const withoutComments = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const MIDDLE_PANE = withoutComments(
  fs.readFileSync(path.join(SRC, "components/MiddlePane.js"), "utf8")
);
const RAIL_MODEL = withoutComments(
  fs.readFileSync(path.join(SRC, "lib/notesPaneRail.js"), "utf8")
);

const projectChild = (noteCount) =>
  notesRailCount({ activeProjectId: "p1", activeFolderId: "f1", noteCount });

/* ================= 1/2/6. when a count is honest ========================= */

describe("1/2/6. the count belongs to a project-child folder and to nothing else", () => {
  test("1. a selected project-child folder counts its notes", () => {
    expect(projectChild(12)).toBe(12);
    expect(projectChild(1)).toBe(1);
    expect(formatNoteCount(projectChild(12))).toBe("12");
  });

  test("2. an EMPTY project-child folder shows a real zero — that is a true statement", () => {
    expect(projectChild(0)).toBe(0);
    expect(formatNoteCount(projectChild(0))).toBe("0");
  });

  test("6. a root-level folder has no applicable count, so none is shown", () => {
    // A root folder genuinely has notes, but they are not what this count
    // measures — "0" here would claim an emptiness that is not being measured.
    expect(notesRailCount({ activeProjectId: null, activeFolderId: "f1", noteCount: 4 })).toBeNull();
    expect(notesRailCount({ activeProjectId: null, activeFolderId: "f1", noteCount: 0 })).toBeNull();
    expect(formatNoteCount(null)).toBe("");
  });

  test("6. no folder at all, and unusable counts, are omitted rather than guessed", () => {
    expect(notesRailCount({ activeProjectId: "p1", activeFolderId: null, noteCount: 3 })).toBeNull();
    expect(notesRailCount({})).toBeNull();
    expect(notesRailCount()).toBeNull();
    for (const bad of [NaN, -1, "many", null, undefined, {}]) {
      expect(projectChild(bad)).toBeNull();
    }
  });
});

/* ========================= 7. the visual cap ============================= */

describe("7. the count is capped so a number cannot widen the rail", () => {
  test("everything up to the cap is shown exactly", () => {
    expect(NOTE_COUNT_DISPLAY_CAP).toBe(99);
    expect(formatNoteCount(0)).toBe("0");
    expect(formatNoteCount(9)).toBe("9");
    expect(formatNoteCount(99)).toBe("99");
  });

  test("above it, 99+", () => {
    expect(formatNoteCount(100)).toBe("99+");
    expect(formatNoteCount(4820)).toBe("99+");
  });

  test("the displayed text is never more than three characters", () => {
    for (const n of [0, 1, 9, 10, 99, 100, 1000, 999999]) {
      expect(formatNoteCount(n).length).toBeLessThanOrEqual(3);
    }
  });

  test("junk formats to nothing rather than to a stray glyph", () => {
    for (const bad of [NaN, -3, "x", undefined, null]) {
      expect(formatNoteCount(bad)).toBe("");
    }
  });
});

/* ======================= 8. the accessible name ========================= */

describe("8. the restore control says the count in words", () => {
  test("the required wording, exactly", () => {
    expect(notesRailRestoreLabel(12)).toBe("Expand notes pane, 12 notes");
    expect(notesRailRestoreLabel(0)).toBe("Expand notes pane, no notes");
  });

  test("one note is singular — a screen reader should not say '1 notes'", () => {
    expect(notesRailRestoreLabel(1)).toBe("Expand notes pane, 1 note");
  });

  test("a large count is spoken in full, even though the rail shows 99+", () => {
    // The eye gets the capped glyph; the accessible name gets the truth.
    expect(formatNoteCount(1200)).toBe("99+");
    expect(notesRailRestoreLabel(1200)).toBe("Expand notes pane, 1200 notes");
  });

  test("with no applicable folder it names the action alone — no misleading quantity", () => {
    expect(notesRailRestoreLabel(null)).toBe("Expand notes pane");
    expect(notesRailRestoreLabel(undefined)).toBe("Expand notes pane");
    for (const bad of [NaN, -2]) {
      expect(notesRailRestoreLabel(bad)).toBe("Expand notes pane");
    }
  });
});

/* ============= 3/4/5. it derives, so it cannot go stale ================= */

describe("3/4/5. the count is derived from the pane's own collection", () => {
  test("3/4. it is the length of the SAME list the expanded pane renders", () => {
    expect(MIDDLE_PANE).toMatch(/noteCount: notes\.length,/);
    // `notes` is resolved per render from the folder's own contents, so a
    // creation or a deletion changes it with nothing to keep in step.
    expect(MIDDLE_PANE).toMatch(/const notes =\s*\n\s*activeProjectId && activeFolderId/);
    expect(MIDDLE_PANE).toMatch(/\?\.notes \|\| \[\]/);
  });

  test("5. switching folders re-derives it — there is no per-folder count state", () => {
    expect(MIDDLE_PANE).not.toMatch(/useState\([^)]*[Cc]ount/);
    expect(MIDDLE_PANE).not.toMatch(/useMemo\([^)]*[Cc]ount/);
    expect(MIDDLE_PANE).not.toMatch(/noteCountRef|countRef/);
    // The rail reads the same two ids the list does.
    expect(MIDDLE_PANE).toMatch(/notesRailCount\(\{\s*\n\s*activeProjectId,\s*\n\s*activeFolderId,\s*\n\s*noteCount: notes\.length,\s*\n\s*\}\)/);
  });

  test("no separate counting logic exists anywhere — one collection, one length", () => {
    expect(MIDDLE_PANE).not.toMatch(/\.filter\([^)]*\)\.length/);
    expect(RAIL_MODEL).not.toMatch(/folderMap|rootFolderNotesMap|useAppState/);
    expect(RAIL_MODEL).not.toMatch(/^import /m);
  });
});

/* ============================ the rail itself =========================== */

describe("the rail shows identity, count and the way back — as one control", () => {
  test("it renders in flow at the sidebar rail's own width, never floating", () => {
    expect(MIDDLE_PANE).toMatch(/id="middlePaneRail"/);
    expect(MIDDLE_PANE).toMatch(/className="w-14 shrink-0 min-h-0 h-full flex flex-col/);
    expect(MIDDLE_PANE).not.toMatch(/\bfixed\b|\babsolute\b/);
    expect(MIDDLE_PANE).toContain('aria-label="Notes pane, collapsed"');
  });

  test("one button carries the arrow, the Notes icon and the count — no nested interactives", () => {
    const rail = MIDDLE_PANE.slice(
      MIDDLE_PANE.indexOf("if (middlePaneHidden) {"),
      MIDDLE_PANE.indexOf("const onNewNote")
    );
    expect((rail.match(/<button/g) || []).length).toBe(1);
    expect(rail).toMatch(/<FaAngleDoubleRight aria-hidden="true" \/>/);
    expect(rail).toMatch(/<FaRegStickyNote aria-hidden="true" \/>/);
    expect(rail).toMatch(/onClick=\{onShowMiddlePane\}/);
    expect(rail).toMatch(/aria-label=\{railLabel\}/);
    expect(rail).toMatch(/title=\{railLabel\}/);
    // No per-note icon: the rail lists nothing.
    expect(rail).not.toMatch(/notes\.map/);
  });

  test("the number is decoration — the accessible name already carries it", () => {
    const rail = MIDDLE_PANE.slice(
      MIDDLE_PANE.indexOf("if (middlePaneHidden) {"),
      MIDDLE_PANE.indexOf("const onNewNote")
    );
    expect(rail).toMatch(/\{railText !== "" && \(/);
    expect(rail).toMatch(/aria-hidden="true"\s*\n\s*>\s*\n\s*\{railText\}/);
    // Fixed-width digits, so adding a note cannot shift the rail.
    expect(rail).toMatch(/tabular-nums/);
  });

  test("7. the sidebar's own collapse and the Notes rail are independent and coexist", () => {
    const sidebar = withoutComments(
      fs.readFileSync(path.join(SRC, "components/Sidebar.js"), "utf8")
    );
    // Two panes, two independent collapse states, two separate controls.
    // Neither reads the other's, so all four combinations render.
    expect(sidebar).not.toMatch(/middlePaneHidden/);
    expect(MIDDLE_PANE).not.toMatch(/sidebarCollapsed|sidebarIsRail|collapsed=/);
    const app = withoutComments(fs.readFileSync(path.join(SRC, "App.js"), "utf8"));
    expect(app).toContain("const [sidebarCollapsed, setSidebarCollapsed] = useState(false);");
    expect(app).toContain("const [middlePaneHidden, setMiddlePaneHidden] = useState(false);");
    // Both rails are in flow at the same width, so they simply sit side by side.
    expect(MIDDLE_PANE).toMatch(/className="w-14 shrink-0/);
    expect(sidebar).toContain('SIDEBAR_RAIL_WIDTH_CLASS = "w-14"');
  });

  test("8. restoring the pane saves nothing and cannot remount an editor", () => {
    const rail = MIDDLE_PANE.slice(
      MIDDLE_PANE.indexOf("if (middlePaneHidden) {"),
      MIDDLE_PANE.indexOf("const onNewNote")
    );
    // The rail's only action is the App-owned visibility handler: it writes no
    // note, touches no editor and dispatches no transaction.
    expect(rail).not.toMatch(/localStorage|setCurrentNoteId|addNoteToFolder|deleteNote|renameNote/);
    expect(rail).not.toMatch(/editor|dispatch|useEditor/);
    expect((rail.match(/onClick=/g) || []).length).toBe(1);
    // Visibility is a prop from App, not state MiddlePane owns, so toggling it
    // re-renders the panes and nothing below them — MainArea is a sibling.
    expect(MIDDLE_PANE).not.toMatch(/useState\([^)]*[Hh]idden/);
    const app = withoutComments(fs.readFileSync(path.join(SRC, "App.js"), "utf8"));
    expect(app).toMatch(/<MainArea \/>/);
    expect(app).not.toMatch(/<MainArea key=/);
  });

  test("restoring is the App-owned handler, so the rail invents no state", () => {
    expect(MIDDLE_PANE).toMatch(
      /export default function MiddlePane\(\{\s*\n\s*middlePaneHidden,\s*\n\s*onHideMiddlePane,\s*\n\s*onShowMiddlePane,\s*\n\s*\}\)/
    );
    const app = withoutComments(fs.readFileSync(path.join(SRC, "App.js"), "utf8"));
    expect(app).toMatch(/onShowMiddlePane=\{\(\) => setMiddlePaneHidden\(false\)\}/);
    // Both panes still take it from App — one owner for one piece of state.
    expect((app.match(/onShowMiddlePane=/g) || []).length).toBe(2);
  });
});
