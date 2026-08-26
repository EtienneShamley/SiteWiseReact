// src/lib/noteDrag.test.js
//
// DRAGGING A NOTE TO A FOLDER — the pure interaction rules (Phase B2): how a
// note drag is recognised, that only the note id travels, and that hovering a
// collapsed project reveals it once — never flapping, never restarting.
import {
  NOTE_DRAG_TYPE,
  PROJECT_HOVER_REVEAL_MS,
  isNoteDragTransfer,
  noteDragSourceProps,
  projectHoverDue,
  projectHoverLeft,
  projectHoverSeen,
  readDraggedNoteId,
} from "./noteDrag";

function transfer(types = [], data = {}) {
  return {
    types,
    getData: (t) => data[t] || "",
    setData(t, v) {
      this.types = [...this.types, t];
      data[t] = v;
    },
    effectAllowed: "uninitialized",
  };
}

describe("recognising a note drag", () => {
  test("only the custom note type counts — a file, a URL or text drag is never a note", () => {
    expect(isNoteDragTransfer(transfer([NOTE_DRAG_TYPE]))).toBe(true);
    expect(isNoteDragTransfer(transfer(["Files"]))).toBe(false);
    expect(isNoteDragTransfer(transfer(["text/plain", "text/uri-list"]))).toBe(false);
    expect(isNoteDragTransfer(transfer([]))).toBe(false);
    expect(isNoteDragTransfer(null)).toBe(false);
    expect(isNoteDragTransfer({})).toBe(false);
  });

  test("a drop yields the note id; anything else yields null, and a throwing getData is null too", () => {
    expect(readDraggedNoteId(transfer([NOTE_DRAG_TYPE], { [NOTE_DRAG_TYPE]: "note-1" }))).toBe("note-1");
    expect(readDraggedNoteId(transfer([NOTE_DRAG_TYPE], {}))).toBeNull();
    expect(readDraggedNoteId(transfer(["text/plain"], { "text/plain": "note-1" }))).toBeNull();
    expect(
      readDraggedNoteId({
        types: [NOTE_DRAG_TYPE],
        getData: () => {
          throw new Error("denied");
        },
      })
    ).toBeNull();
  });
});

describe("the drag source", () => {
  test("carries the note id under the note type ONLY (no text/plain), asks for a move, and reports begin/end", () => {
    const begun = [];
    let ended = 0;
    const props = noteDragSourceProps({
      noteId: "note-1",
      title: "Site visit",
      onBegin: (id, title) => begun.push([id, title]),
      onEnd: () => (ended += 1),
    });
    expect(props.draggable).toBe(true);
    const dt = transfer();
    let prevented = false;
    props.onDragStart({ target: { closest: () => null }, dataTransfer: dt, preventDefault: () => (prevented = true) });
    expect(prevented).toBe(false);
    expect(dt.types).toEqual([NOTE_DRAG_TYPE]);
    expect(dt.getData(NOTE_DRAG_TYPE)).toBe("note-1");
    expect(dt.effectAllowed).toBe("move");
    expect(begun).toEqual([["note-1", "Site visit"]]);
    props.onDragEnd();
    expect(ended).toBe(1);
  });

  test("a press that starts on an opted-out control (the menu trigger) never becomes a drag", () => {
    const begun = [];
    const props = noteDragSourceProps({ noteId: "note-1", title: "x", onBegin: () => begun.push(1) });
    const dt = transfer();
    let prevented = false;
    props.onDragStart({
      target: { closest: (sel) => (sel === "[data-nw-no-drag]" ? {} : null) },
      dataTransfer: dt,
      preventDefault: () => (prevented = true),
    });
    expect(prevented).toBe(true);
    expect(dt.types).toEqual([]);
    expect(begun).toEqual([]);
  });

  test("a transfer that refuses the type starts no drag session", () => {
    const begun = [];
    const props = noteDragSourceProps({ noteId: "note-1", title: "x", onBegin: () => begun.push(1) });
    let prevented = false;
    props.onDragStart({
      target: { closest: () => null },
      dataTransfer: {
        setData() {
          throw new Error("no");
        },
      },
      preventDefault: () => (prevented = true),
    });
    expect(prevented).toBe(true);
    expect(begun).toEqual([]);
  });
});

describe("14. hovering a collapsed project during a drag reveals its folders — once, without flapping", () => {
  test("first sight schedules a reveal; repeated sightings keep the SAME schedule (its clock never restarts)", () => {
    const p1 = projectHoverSeen(null, { projectId: "pB", expandedProjectId: "pA", now: 1000 });
    expect(p1).toEqual({ projectId: "pB", since: 1000 });
    const p2 = projectHoverSeen(p1, { projectId: "pB", expandedProjectId: "pA", now: 1300 });
    expect(p2).toBe(p1);
    expect(projectHoverDue(p2, 1000 + PROJECT_HOVER_REVEAL_MS - 1)).toBe(false);
    expect(projectHoverDue(p2, 1000 + PROJECT_HOVER_REVEAL_MS)).toBe(true);
  });

  test("a project that is ALREADY expanded schedules nothing — there is nothing to reveal and nothing to toggle", () => {
    expect(projectHoverSeen(null, { projectId: "pA", expandedProjectId: "pA", now: 5 })).toBeNull();
    const pending = { projectId: "pB", since: 1 };
    expect(projectHoverSeen(pending, { projectId: "pA", expandedProjectId: "pA", now: 5 })).toBeNull();
  });

  test("moving to a different project replaces the schedule; leaving clears it; garbage schedules nothing", () => {
    const pB = projectHoverSeen(null, { projectId: "pB", expandedProjectId: null, now: 0 });
    const pC = projectHoverSeen(pB, { projectId: "pC", expandedProjectId: null, now: 200 });
    expect(pC).toEqual({ projectId: "pC", since: 200 });
    expect(projectHoverLeft()).toBeNull();
    expect(projectHoverSeen(pB, { projectId: "", expandedProjectId: null, now: 0 })).toBeNull();
    expect(projectHoverSeen(pB, { projectId: null, expandedProjectId: null, now: 0 })).toBeNull();
    expect(projectHoverDue(null, 9999)).toBe(false);
    expect(projectHoverDue({ projectId: "p", since: NaN }, 9999)).toBe(false);
  });

  test("the reveal delay is short but deliberate", () => {
    expect(PROJECT_HOVER_REVEAL_MS).toBeGreaterThanOrEqual(400);
    expect(PROJECT_HOVER_REVEAL_MS).toBeLessThanOrEqual(1000);
  });
});
