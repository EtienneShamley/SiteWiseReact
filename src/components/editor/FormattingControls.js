import React, { useCallback, useEffect, useRef, useState } from "react";
import { useEditorState } from "@tiptap/react";
import {
  FaBold, FaItalic, FaUnderline, FaStrikethrough, FaListUl, FaListOl,
  FaCheckSquare, FaQuoteRight, FaCode, FaHighlighter, FaLink, FaImage,
  FaTable, FaUndo, FaRedo, FaHeading, FaGlobe, FaRemoveFormat,
  FaIndent, FaOutdent, FaSubscript, FaSuperscript, FaMinus, FaUnlink,
  FaAlignLeft, FaAlignCenter, FaAlignRight, FaAlignJustify, FaCaretDown,
} from "react-icons/fa";
import { FONT_FAMILIES, FONT_SIZES } from "../../constants/editorOptions";
import { getNearestListItemType } from "./extensions";
import {
  applyHighlightColor,
  applyLink,
  applyTextColor,
  insertImageFromUrl,
  removeLink as removeLinkCommand,
} from "../../lib/editorCommands";
import { validateEditorImageFile } from "../../lib/editorImages";
import { insertLocalImageAsset } from "../../lib/editorImageInsert";
import { isToolbarControlAllowed } from "../../lib/editorToolbarState";
import useTransientMessage from "../../hooks/useTransientMessage";
import { MESSAGE_TONE } from "../../lib/transientMessage";

/**
 * @param editor    the editor this toolbar currently OWNS. In the Free-form
 *                  view that is the note's editor; in the Template form it is
 *                  the single active Text-row editor.
 * @param disabled  true when nothing owns the toolbar (no note open, or the
 *                  Template form visible with no active Text answer). Every
 *                  control below is genuinely disabled in that state — the
 *                  Free-form editor is only hidden with display:none, so an
 *                  enabled control would otherwise dispatch into a document
 *                  nobody can see and persist the result.
 * @param controls  the permitted control set, or null for all of them. A
 *                  Template Text answer is a form field, not a document: images,
 *                  files, tables, headings and document-wide actions stay
 *                  present but disabled there (TEMPLATE_TEXT_CONTROLS in
 *                  src/lib/editorToolbarState.js), so the toolbar keeps one
 *                  shape and one position in every view.
 * @param disabledHint  a short explanation shown when nothing owns the toolbar.
 */
export default function FormattingControls({
  editor,
  disabled = false,
  controls = null,
  disabledHint = null,
}) {
  const fileInputRef = useRef();
  const tableMenuRef = useRef(null);
  const textColorRef = useRef(null);
  const highlightColorRef = useRef(null);
  const [tableMenuOpen, setTableMenuOpen] = useState(false);
  // One restrained inline message for a rejected link, image or colour, with a
  // managed lifetime — it auto-dismisses, a new attempt supersedes it, and a
  // success clears it. It used to have no lifecycle at all and stayed on screen
  // indefinitely. See src/lib/transientMessage.js.
  const controlMessage = useTransientMessage();
  const { clear: clearControlMessage, showError: showControlError } = controlMessage;
  // True while an image is being normalized and written to IndexedDB. The
  // document is not touched until that write is confirmed.
  const [imageBusy, setImageBusy] = useState(false);

  // TipTap v3 does not re-render React on selection changes, so every
  // active/disabled/attribute read the toolbar depends on must go through
  // useEditorState — direct editor.isActive() calls at render time go stale.
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const listItemType = getNearestListItemType(e.state);
      return {
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        underline: e.isActive("underline"),
        strike: e.isActive("strike"),
        subscript: e.isActive("subscript"),
        superscript: e.isActive("superscript"),
        heading1: e.isActive("heading", { level: 1 }),
        blockquote: e.isActive("blockquote"),
        codeBlock: e.isActive("codeBlock"),
        bulletList: e.isActive("bulletList"),
        orderedList: e.isActive("orderedList"),
        taskList: e.isActive("taskList"),
        // Undo/redo availability comes from the editor's own history, exactly
        // like every other active state, so the buttons cannot advertise a
        // step that does not exist. This history is TipTap's own, and is
        // entirely separate from the AI Refine backups.
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        canIndent: !!listItemType && e.can().sinkListItem(listItemType),
        canOutdent: !!listItemType && e.can().liftListItem(listItemType),
        alignLeft: e.isActive({ textAlign: "left" }),
        alignCenter: e.isActive({ textAlign: "center" }),
        alignRight: e.isActive({ textAlign: "right" }),
        alignJustify: e.isActive({ textAlign: "justify" }),
        link: e.isActive("link"),
        inTable: e.isActive("table"),
        highlight: e.isActive("highlight"),
        highlightColor: e.getAttributes("highlight").color || "#FFFF00",
        fontFamily: e.getAttributes("textStyle").fontFamily || "",
        fontSize: e.getAttributes("textStyle").fontSize || "",
        color: e.getAttributes("textStyle").color || "#000000",
      };
    },
  });

  // Close the table menu on any click outside it.
  useEffect(() => {
    if (!tableMenuOpen) return;
    const onPointerDown = (e) => {
      if (tableMenuRef.current && !tableMenuRef.current.contains(e.target)) {
        setTableMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [tableMenuOpen]);

  // A message about a rejected control must not outlive the state it described.
  // It clears when the toolbar becomes unavailable (switching to the Template
  // form) and when the editor instance changes — the editor is recreated per
  // note, so this is what clears a stale image message on a note switch.
  useEffect(() => {
    if (disabled) clearControlMessage();
  }, [disabled, clearControlMessage]);

  useEffect(() => {
    clearControlMessage();
  }, [editor, clearControlMessage]);

  useEffect(() => {
    if (disabled) setTableMenuOpen(false);
  }, [disabled]);

  const report = useCallback(
    (result) => {
      if (result && result.ok === false && result.error) showControlError(result.error);
      else clearControlMessage();
    },
    [showControlError, clearControlMessage]
  );

  // Native colour inputs: COMMIT ONCE per chosen colour.
  //
  // React maps onChange for an <input type="color"> onto the DOM `input`
  // event, which fires continuously while the picker is being dragged — that
  // is what produced dozens of transactions and undo entries per colour, and
  // what made the highlight control toggle itself on and off mid-drag. The
  // native `change` event fires once, when the user commits, so it is
  // subscribed directly here. The inputs are keyed on the editor's current
  // colour so the swatch still follows the selection.
  // A control that is not permitted in the current view is as inert as a
  // disabled one — including its native event listener.
  const textColorOff = disabled || !isToolbarControlAllowed(controls, "textColor");
  const highlightColorOff =
    disabled || !isToolbarControlAllowed(controls, "highlightColor");

  useEffect(() => {
    const el = textColorRef.current;
    if (!el || !editor || textColorOff) return;
    const onCommit = (e) => report(applyTextColor(editor, e.target.value));
    el.addEventListener("change", onCommit);
    return () => el.removeEventListener("change", onCommit);
  }, [editor, textColorOff, report, s?.color]);

  useEffect(() => {
    const el = highlightColorRef.current;
    if (!el || !editor || highlightColorOff) return;
    const onCommit = (e) => report(applyHighlightColor(editor, e.target.value));
    el.addEventListener("change", onCommit);
    return () => el.removeEventListener("change", onCommit);
  }, [editor, highlightColorOff, report, s?.highlightColor]);

  // Font size: uses the official FontSize extension (bundled with
  // @tiptap/extension-text-style) so the value is a real registered
  // attribute on the textStyle mark, not a silently-dropped one.
  const setFontSize = (size) => {
    if (!editor) return;
    if (!size) {
      editor.chain().focus().unsetFontSize().run();
    } else {
      editor.chain().focus().setFontSize(size).run();
    }
  };

  // Font family: unset when blank if command exists; else default stack
  const setFontFamily = (family) => {
    if (!editor) return;
    if (!family && editor.commands?.unsetFontFamily) {
      editor.chain().focus().unsetFontFamily().run();
    } else {
      editor.chain().focus().setFontFamily(family || "Arial, sans-serif").run();
    }
  };

  const clearFormatting = () => {
    if (!editor) return;
    editor.chain().focus().clearNodes().unsetAllMarks().run();
  };

  // Indent/outdent must target the item type nearest the cursor — see
  // getNearestListItemType for why isActive() checks are not enough here.
  const indentListItem = () => {
    if (!editor) return;
    const type = getNearestListItemType(editor.state);
    if (!type) return;
    editor.chain().focus().sinkListItem(type).run();
  };
  const outdentListItem = () => {
    if (!editor) return;
    const type = getNearestListItemType(editor.state);
    if (!type) return;
    editor.chain().focus().liftListItem(type).run();
  };

  // Insert on empty selection / apply on selection / edit in place when the
  // cursor is on an existing link (prefilled prompt; clearing the URL removes
  // the link). The URL is validated against a protocol allowlist before
  // anything is dispatched, so cancelling or entering an unsafe address leaves
  // the document untouched — see src/lib/editorCommands.js.
  const editLink = () => {
    if (!editor) return;
    const previous = editor.getAttributes("link").href || "";
    const url = window.prompt("Enter URL", previous);
    report(applyLink(editor, url));
  };

  const removeLink = () => {
    if (!editor) return;
    report(removeLinkCommand(editor));
  };

  // Local upload. The decision is made from the Blob's own type and size, not
  // from the filename or the input's accept hint, and a rejected file inserts
  // nothing at all.
  //
  // The bytes go to IndexedDB and only a reference enters the document, so the
  // node is inserted ONLY after that write is confirmed — see
  // src/lib/editorImageInsert.js for the full ordering.
  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    // Cancelling the picker is not a failure: nothing happens and nothing is
    // said.
    if (!file || !editor) return;

    // A new attempt supersedes whatever the last one said.
    clearControlMessage();

    // Cheap rejections happen before any decoding work.
    const check = validateEditorImageFile(file);
    if (!check.ok) {
      showControlError(check.error);
      return;
    }

    setImageBusy(true);
    try {
      const result = await insertLocalImageAsset({
        sourceFile: file,
        editor,
        name: file.name,
      });
      report(result);
    } finally {
      setImageBusy(false);
    }
  };

  const insertImageUrl = () => {
    if (!editor) return;
    const url = window.prompt("Enter image URL");
    report(insertImageFromUrl(editor, url));
  };

  if (!editor || !s) return null;

  // Shared visual language for every toolbar control: neutral gray hover,
  // smooth transitions, and a focus-visible ring for keyboard use.
  const btnBase =
    "p-2 rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50";
  const btnDisabled =
    "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent dark:disabled:hover:bg-transparent disabled:hover:text-gray-700 dark:disabled:hover:text-gray-300";
  const activeBg = "bg-gray-200 dark:bg-gray-700";
  const selectCls =
    "rounded-md px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50 disabled:opacity-40 disabled:cursor-not-allowed";
  const colorInputCls =
    "w-7 h-7 rounded-md border border-gray-300 dark:border-gray-700 cursor-pointer transition-colors hover:border-gray-400 dark:hover:border-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50 disabled:opacity-40 disabled:cursor-not-allowed";
  const menuItemCls =
    "w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent dark:disabled:hover:bg-transparent transition-colors";

  // Every control shares the same "is this surface live" gate, so none of them
  // can act while the editor they would target is hidden or absent — plus the
  // per-view permitted set, so a control the current surface does not support
  // is disabled rather than quietly doing something inappropriate to it.
  const off = disabled;
  const offFor = (key) => off || !isToolbarControlAllowed(controls, key);

  // A control that cannot act must not advertise a state either. The editor
  // state snapshot belongs to whichever editor last owned the toolbar, so
  // without this a control could still look "on" after ownership moved away
  // from the row that made it so.
  const pressed = (flag) => !off && !!flag;

  // A toolbar press must not destroy the active editor's selection before the
  // command runs. Preventing the default mousedown keeps focus (and therefore
  // the selection, and therefore the row the command applies to) exactly where
  // it was; every command then re-focuses through editor.chain().focus().
  // Only buttons are guarded: <select> and <input type="color"> need their own
  // native mousedown behaviour to open at all.
  const preserveSelectionOnPress = (event) => {
    if (event.target && event.target.closest && event.target.closest("button")) {
      event.preventDefault();
    }
  };

  // Subtle vertical separator between toolbar groups.
  const Divider = () => (
    <span
      aria-hidden="true"
      className="w-px self-stretch bg-gray-300 dark:bg-gray-700 mx-1"
    />
  );

  const runTable = (fn) => {
    fn();
    setTableMenuOpen(false);
  };

  const tableItems = [
    { label: "Insert row above", can: () => editor.can().addRowBefore(), run: () => editor.chain().focus().addRowBefore().run() },
    { label: "Insert row below", can: () => editor.can().addRowAfter(), run: () => editor.chain().focus().addRowAfter().run() },
    { label: "Delete row", can: () => editor.can().deleteRow(), run: () => editor.chain().focus().deleteRow().run() },
    { label: "Insert column left", can: () => editor.can().addColumnBefore(), run: () => editor.chain().focus().addColumnBefore().run() },
    { label: "Insert column right", can: () => editor.can().addColumnAfter(), run: () => editor.chain().focus().addColumnAfter().run() },
    { label: "Delete column", can: () => editor.can().deleteColumn(), run: () => editor.chain().focus().deleteColumn().run() },
    { label: "Merge cells", can: () => editor.can().mergeCells(), run: () => editor.chain().focus().mergeCells().run() },
    { label: "Split cell", can: () => editor.can().splitCell(), run: () => editor.chain().focus().splitCell().run() },
  ];

  return (
    <div className="flex flex-wrap items-center gap-1" onMouseDown={preserveSelectionOnPress}>
      {/* History — the OWNING editor's own history (session-only). In the
          Template form that is the active row's editor, so Undo/Redo can only
          ever step through that row's edits, never another row's and never the
          Free-form note's. */}
      <div className="flex items-center gap-1">
        <button onClick={() => editor.chain().focus().undo().run()} disabled={offFor("undo") || !s.canUndo} className={`${btnBase} ${btnDisabled}`} title="Undo" aria-label="Undo"><FaUndo /></button>
        <button onClick={() => editor.chain().focus().redo().run()} disabled={offFor("redo") || !s.canRedo} className={`${btnBase} ${btnDisabled}`} title="Redo" aria-label="Redo"><FaRedo /></button>
      </div>

      <Divider />

      {/* Text */}
      <div className="flex items-center gap-1">
        <select
          onChange={(e) => setFontFamily(e.target.value)}
          value={s.fontFamily}
          disabled={offFor("fontFamily")}
          className={selectCls}
          title="Font Family"
          aria-label="Font family"
        >
          <option value="">Font</option>
          {FONT_FAMILIES.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>

        <select
          onChange={(e) => setFontSize(e.target.value)}
          value={s.fontSize}
          disabled={offFor("fontSize")}
          className={selectCls}
          title="Font Size"
          aria-label="Font size"
        >
          <option value="">Size</option>
          {FONT_SIZES.map((sz) => (
            <option key={sz.value} value={sz.value}>{sz.label}</option>
          ))}
        </select>

        <button
          onClick={clearFormatting}
          disabled={offFor("clearFormatting")}
          className={`${btnBase} ${btnDisabled}`}
          title="Clear Formatting"
          aria-label="Clear formatting"
        >
          <FaRemoveFormat />
        </button>
      </div>

      <Divider />

      {/* Formatting */}
      <div className="flex items-center gap-1">
        <button onClick={() => editor.chain().focus().toggleBold().run()} disabled={offFor("bold")} aria-pressed={pressed(s.bold)} className={`${btnBase} ${btnDisabled} ${pressed(s.bold) ? `${activeBg} font-bold text-blue-600` : ""}`} title="Bold" aria-label="Bold"><FaBold /></button>
        <button onClick={() => editor.chain().focus().toggleItalic().run()} disabled={offFor("italic")} aria-pressed={pressed(s.italic)} className={`${btnBase} ${btnDisabled} ${pressed(s.italic) ? `${activeBg} italic text-blue-600` : ""}`} title="Italic" aria-label="Italic"><FaItalic /></button>
        <button onClick={() => editor.chain().focus().toggleUnderline().run()} disabled={offFor("underline")} aria-pressed={pressed(s.underline)} className={`${btnBase} ${btnDisabled} ${pressed(s.underline) ? `${activeBg} underline text-blue-600` : ""}`} title="Underline" aria-label="Underline"><FaUnderline /></button>
        <button onClick={() => editor.chain().focus().toggleStrike().run()} disabled={offFor("strike")} aria-pressed={pressed(s.strike)} className={`${btnBase} ${btnDisabled} ${pressed(s.strike) ? `${activeBg} line-through text-blue-600` : ""}`} title="Strikethrough" aria-label="Strikethrough"><FaStrikethrough /></button>
        <button onClick={() => editor.chain().focus().toggleSubscript().run()} disabled={offFor("subscript")} aria-pressed={pressed(s.subscript)} className={`${btnBase} ${btnDisabled} ${pressed(s.subscript) ? `${activeBg} text-blue-600` : ""}`} title="Subscript" aria-label="Subscript"><FaSubscript /></button>
        <button onClick={() => editor.chain().focus().toggleSuperscript().run()} disabled={offFor("superscript")} aria-pressed={pressed(s.superscript)} className={`${btnBase} ${btnDisabled} ${pressed(s.superscript) ? `${activeBg} text-blue-600` : ""}`} title="Superscript" aria-label="Superscript"><FaSuperscript /></button>
        <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} disabled={offFor("heading1")} aria-pressed={pressed(s.heading1)} className={`${btnBase} ${btnDisabled} ${pressed(s.heading1) ? `${activeBg} font-bold text-purple-600` : ""}`} title="Heading 1" aria-label="Heading 1"><FaHeading /></button>
        <button onClick={() => editor.chain().focus().toggleBlockquote().run()} disabled={offFor("blockquote")} aria-pressed={pressed(s.blockquote)} className={`${btnBase} ${btnDisabled} ${pressed(s.blockquote) ? `${activeBg} text-blue-600` : ""}`} title="Quote" aria-label="Quote"><FaQuoteRight /></button>
        <button onClick={() => editor.chain().focus().toggleCodeBlock().run()} disabled={offFor("codeBlock")} aria-pressed={pressed(s.codeBlock)} className={`${btnBase} ${btnDisabled} ${pressed(s.codeBlock) ? `${activeBg} text-yellow-600` : ""}`} title="Code" aria-label="Code block"><FaCode /></button>
      </div>

      <Divider />

      {/* Lists */}
      <div className="flex items-center gap-1">
        <button onClick={() => editor.chain().focus().toggleBulletList().run()} disabled={offFor("bulletList")} aria-pressed={pressed(s.bulletList)} className={`${btnBase} ${btnDisabled} ${pressed(s.bulletList) ? `${activeBg} text-blue-600` : ""}`} title="Bullet List" aria-label="Bullet list"><FaListUl /></button>
        <button onClick={() => editor.chain().focus().toggleOrderedList().run()} disabled={offFor("orderedList")} aria-pressed={pressed(s.orderedList)} className={`${btnBase} ${btnDisabled} ${pressed(s.orderedList) ? `${activeBg} text-blue-600` : ""}`} title="Numbered List" aria-label="Numbered list"><FaListOl /></button>
        <button onClick={() => editor.chain().focus().toggleTaskList().run()} disabled={offFor("taskList")} aria-pressed={pressed(s.taskList)} className={`${btnBase} ${btnDisabled} ${pressed(s.taskList) ? `${activeBg} text-green-600` : ""}`} title="To-do List" aria-label="Task list"><FaCheckSquare /></button>
        {/* Indent/outdent are LIST NESTING only — they act on the nearest list
            item and are disabled outside a list. There is deliberately no
            arbitrary paragraph indent, and no margin/padding is ever stored. */}
        <button onClick={indentListItem} disabled={offFor("indent") || !s.canIndent} className={`${btnBase} ${btnDisabled}`} title="Indent (Tab)" aria-label="Indent list item"><FaIndent /></button>
        <button onClick={outdentListItem} disabled={offFor("outdent") || !s.canOutdent} className={`${btnBase} ${btnDisabled}`} title="Outdent (Shift+Tab)" aria-label="Outdent list item"><FaOutdent /></button>
      </div>

      <Divider />

      {/* Alignment */}
      <div className="flex items-center gap-1">
        <button onClick={() => editor.chain().focus().setTextAlign("left").run()} disabled={offFor("alignLeft")} aria-pressed={pressed(s.alignLeft)} className={`${btnBase} ${btnDisabled} ${pressed(s.alignLeft) ? `${activeBg} text-blue-600` : ""}`} title="Align Left" aria-label="Align left"><FaAlignLeft /></button>
        <button onClick={() => editor.chain().focus().setTextAlign("center").run()} disabled={offFor("alignCenter")} aria-pressed={pressed(s.alignCenter)} className={`${btnBase} ${btnDisabled} ${pressed(s.alignCenter) ? `${activeBg} text-blue-600` : ""}`} title="Align Centre" aria-label="Align centre"><FaAlignCenter /></button>
        <button onClick={() => editor.chain().focus().setTextAlign("right").run()} disabled={offFor("alignRight")} aria-pressed={pressed(s.alignRight)} className={`${btnBase} ${btnDisabled} ${pressed(s.alignRight) ? `${activeBg} text-blue-600` : ""}`} title="Align Right" aria-label="Align right"><FaAlignRight /></button>
        <button onClick={() => editor.chain().focus().setTextAlign("justify").run()} disabled={offFor("alignJustify")} aria-pressed={pressed(s.alignJustify)} className={`${btnBase} ${btnDisabled} ${pressed(s.alignJustify) ? `${activeBg} text-blue-600` : ""}`} title="Justify" aria-label="Justify"><FaAlignJustify /></button>
      </div>

      <Divider />

      {/* Insert */}
      <div className="flex items-center gap-1">
        <button
          onClick={editLink}
          disabled={offFor("link")}
          aria-pressed={pressed(s.link)}
          className={`${btnBase} ${btnDisabled} ${pressed(s.link) ? `${activeBg} text-blue-600` : ""}`}
          title="Insert / Edit Link"
          aria-label="Insert or edit link"
        >
          <FaLink />
        </button>
        <button
          onClick={removeLink}
          disabled={offFor("unlink") || !s.link}
          className={`${btnBase} ${btnDisabled}`}
          title="Remove Link"
          aria-label="Remove link"
        >
          <FaUnlink />
        </button>

        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          ref={fileInputRef}
          onChange={handleImageUpload}
        />
        {/* Local file picker — an image icon, never a camera icon: this does
            NOT take a photo. The camera icon is reserved for real capture. */}
        <button
          title={imageBusy ? "Adding image…" : "Upload Photo"}
          aria-label="Upload photo from this device"
          onClick={() => fileInputRef.current?.click()}
          disabled={offFor("imageUpload") || imageBusy}
          aria-busy={imageBusy || undefined}
          className={`${btnBase} ${btnDisabled}`}
        >
          <FaImage />
        </button>

        {/* Genuinely remote: inserts an image from a web address. */}
        <button
          onClick={insertImageUrl}
          disabled={offFor("imageUrl")}
          className={`${btnBase} ${btnDisabled}`}
          title="Insert image from a web address"
          aria-label="Insert image from a web address"
        >
          <FaGlobe />
        </button>

        <button
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          disabled={offFor("horizontalRule")}
          className={`${btnBase} ${btnDisabled}`}
          title="Horizontal Rule"
          aria-label="Insert horizontal rule"
        >
          <FaMinus />
        </button>

        <button
          onClick={() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
          disabled={offFor("table")}
          className={`${btnBase} ${btnDisabled}`}
          title="Table"
          aria-label="Insert table"
        >
          <FaTable />
        </button>

        <div className="relative" ref={tableMenuRef}>
          <button
            onClick={() => setTableMenuOpen((open) => !open)}
            disabled={offFor("tableOptions") || !s.inTable}
            className={`${btnBase} ${btnDisabled} ${tableMenuOpen ? activeBg : ""} flex items-center`}
            title="Table Options"
            aria-label="Table options"
            aria-haspopup="menu"
            aria-expanded={tableMenuOpen}
          >
            <FaTable />
            <FaCaretDown className="ml-0.5 text-xs" />
          </button>
          {tableMenuOpen && s.inTable && !offFor("tableOptions") && (
            <div
              role="menu"
              className="absolute left-0 top-full mt-1 z-20 min-w-[11rem] py-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
            >
              {tableItems.map((item) => (
                <button
                  key={item.label}
                  role="menuitem"
                  disabled={!item.can()}
                  onClick={() => runTable(item.run)}
                  className={menuItemCls}
                >
                  {item.label}
                </button>
              ))}
              <div className="my-1 border-t border-gray-200 dark:border-gray-700" aria-hidden="true" />
              <button
                role="menuitem"
                onClick={() => runTable(() => editor.chain().focus().deleteTable().run())}
                className={`${menuItemCls} text-red-600 dark:text-red-400`}
              >
                Delete table
              </button>
            </div>
          )}
        </div>
      </div>

      <Divider />

      {/* Colours. Uncontrolled inputs keyed on the editor's current colour:
          the input owns its value while the native picker is open, and the
          committed value is applied once through the native change event. */}
      <div className="flex items-center gap-1">
        <input
          key={`text-color-${s.color}`}
          ref={textColorRef}
          type="color"
          defaultValue={s.color}
          disabled={textColorOff}
          title="Text Color"
          aria-label="Text color"
          className={colorInputCls}
        />
        <input
          key={`highlight-color-${s.highlightColor}`}
          ref={highlightColorRef}
          type="color"
          defaultValue={s.highlightColor}
          disabled={highlightColorOff}
          title="Highlight Color"
          aria-label="Highlight color"
          className={colorInputCls}
        />
        <button onClick={() => editor.chain().focus().toggleHighlight().run()} disabled={offFor("highlight")} aria-pressed={pressed(s.highlight)} className={`${btnBase} ${btnDisabled} ${pressed(s.highlight) ? "bg-yellow-300 dark:bg-yellow-300/80 text-gray-900" : ""}`} title="Highlight" aria-label="Highlight"><FaHighlighter /></button>
      </div>

      {/* Why the controls are inert right now. Present only when there is
          something useful to say — in the Template form with no Text answer
          selected — so a toolbar full of disabled controls explains itself
          instead of looking broken. It is text, never colour or an icon
          alone, and lives in a polite live region so the change of ownership
          is announced once rather than on every keystroke. */}
      {disabledHint && (
        <span
          role="status"
          aria-live="polite"
          className="ml-1 text-xs text-gray-500 dark:text-gray-400"
        >
          {disabledHint}
        </span>
      )}

      {/* Restrained inline feedback for a rejected link, image or colour —
          the document is unchanged whenever this appears. It clears itself
          after a few seconds, on a new attempt, and on a note or view change,
          so a failure notice can never describe something that is no longer
          true. One live region serves the busy state and the message, so the
          status line's presence does not shift the toolbar twice. */}
      {(imageBusy || !!controlMessage.message) && (
        <span
          role="status"
          aria-live="polite"
          className={[
            "ml-1 text-xs max-w-xs",
            controlMessage.tone === MESSAGE_TONE.ERROR
              ? "text-red-600 dark:text-red-400"
              : "text-gray-500 dark:text-gray-400",
          ].join(" ")}
        >
          {imageBusy ? "Adding image…" : controlMessage.message}
        </span>
      )}
    </div>
  );
}
