// src/lib/editorCapabilities.js
//
// WHICH TOOLBAR CONTROLS AN EDITOR SUPPORTS — derived from the editor itself.
//
// The formatting toolbar is ONE toolbar with ONE owner at a time (the Free-form
// note's editor, or the active Template Section's editor — see
// src/lib/editorToolbarState.js). Which of its controls may act is not a
// per-surface list maintained by hand — that list drifted once already, when
// Phase G made a Section a real document and the toolbar went on greying out
// controls the Section could in fact perform. It is DERIVED here from the
// owning editor's schema (which node and mark types exist) and command set
// (which commands are registered), so it can never disagree with what the
// editor can do. Both surfaces are built from the shared editor core
// (src/components/editor/editorCoreExtensions.js), so today the two derived
// sets are identical; should a surface ever configure a capability away for a
// genuine reason, its toolbar follows automatically.
//
// A control key is the string FormattingControls gates a control with. The
// list is exported so a test can prove every rendered control is classified.
//
// Pure with respect to React and the DOM: it reads `editor.schema` and
// `editor.commands` and nothing else, so it is directly unit-testable against
// a real Tiptap schema or a plain object shaped like one.

/** Every control key the formatting toolbar renders. */
export const TOOLBAR_CONTROL_KEYS = Object.freeze([
  "undo",
  "redo",
  "fontFamily",
  "fontSize",
  "clearFormatting",
  "bold",
  "italic",
  "underline",
  "strike",
  "subscript",
  "superscript",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
  "indent",
  "outdent",
  "alignLeft",
  "alignCenter",
  "alignRight",
  "alignJustify",
  "link",
  "unlink",
  "imageUpload",
  "imageUrl",
  "horizontalRule",
  "table",
  "tableOptions",
  "textColor",
  "highlightColor",
  "highlight",
]);

function hasNode(editor, name) {
  return !!(editor && editor.schema && editor.schema.nodes && editor.schema.nodes[name]);
}

function hasMark(editor, name) {
  return !!(editor && editor.schema && editor.schema.marks && editor.schema.marks[name]);
}

function hasCommand(editor, name) {
  return !!(editor && editor.commands && typeof editor.commands[name] === "function");
}

/**
 * The set of control keys the given editor supports, or an EMPTY set for no
 * editor. Never null: "every control" is a fact about the editor, not a
 * default.
 */
export function toolbarControlsForEditor(editor) {
  const controls = new Set();
  if (!editor || !editor.schema) return controls;
  const allow = (key, ok) => {
    if (ok) controls.add(key);
  };

  allow("undo", hasCommand(editor, "undo"));
  allow("redo", hasCommand(editor, "redo"));
  // `clearNodes` / `unsetAllMarks` are Tiptap CORE commands, present on every
  // editor whatever its extensions.
  allow("clearFormatting", true);

  allow("fontFamily", hasMark(editor, "textStyle") && hasCommand(editor, "setFontFamily"));
  allow("fontSize", hasMark(editor, "textStyle") && hasCommand(editor, "setFontSize"));

  allow("bold", hasMark(editor, "bold"));
  allow("italic", hasMark(editor, "italic"));
  allow("underline", hasMark(editor, "underline"));
  allow("strike", hasMark(editor, "strike"));
  allow("subscript", hasMark(editor, "subscript"));
  allow("superscript", hasMark(editor, "superscript"));

  allow("heading", hasNode(editor, "heading"));
  allow("blockquote", hasNode(editor, "blockquote"));
  allow("codeBlock", hasNode(editor, "codeBlock"));

  const lists = hasNode(editor, "listItem") && (hasNode(editor, "bulletList") || hasNode(editor, "orderedList"));
  allow("bulletList", hasNode(editor, "bulletList") && hasNode(editor, "listItem"));
  allow("orderedList", hasNode(editor, "orderedList") && hasNode(editor, "listItem"));
  allow("taskList", hasNode(editor, "taskList") && hasNode(editor, "taskItem"));
  // Indent / outdent are LIST NESTING only.
  allow("indent", lists || hasNode(editor, "taskItem"));
  allow("outdent", lists || hasNode(editor, "taskItem"));

  const align = hasCommand(editor, "setTextAlign");
  allow("alignLeft", align);
  allow("alignCenter", align);
  allow("alignRight", align);
  allow("alignJustify", align);

  allow("link", hasMark(editor, "link"));
  allow("unlink", hasMark(editor, "link"));

  allow("imageUpload", hasNode(editor, "image"));
  allow("imageUrl", hasNode(editor, "image"));
  allow("horizontalRule", hasNode(editor, "horizontalRule"));
  allow("table", hasNode(editor, "table"));
  allow("tableOptions", hasNode(editor, "table"));

  allow("textColor", hasMark(editor, "textStyle") && hasCommand(editor, "setColor"));
  allow("highlightColor", hasMark(editor, "highlight"));
  allow("highlight", hasMark(editor, "highlight"));

  return controls;
}
