import React, { useEffect, useRef, useState } from "react";
import { useEditorState } from "@tiptap/react";
import {
  FaBold, FaItalic, FaUnderline, FaStrikethrough, FaListUl, FaListOl,
  FaCheckSquare, FaQuoteRight, FaCode, FaHighlighter, FaLink, FaImage,
  FaTable, FaUndo, FaRedo, FaHeading, FaCamera, FaRemoveFormat,
  FaIndent, FaOutdent, FaSubscript, FaSuperscript, FaMinus, FaUnlink,
  FaAlignLeft, FaAlignCenter, FaAlignRight, FaAlignJustify, FaCaretDown,
} from "react-icons/fa";
import { FONT_FAMILIES, FONT_SIZES } from "../../constants/editorOptions";
import { getNearestListItemType } from "./extensions";

export default function FormattingControls({ editor }) {
  const fileInputRef = useRef();
  const tableMenuRef = useRef(null);
  const [tableMenuOpen, setTableMenuOpen] = useState(false);

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
  // cursor is on an existing link (prefilled prompt; clearing the URL
  // removes the link). extendMarkRange covers the whole link either way.
  const editLink = () => {
    if (!editor) return;
    const previous = editor.getAttributes("link").href || "";
    const url = window.prompt("Enter URL", previous);
    if (url === null) return;
    const href = url.trim();
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    if (editor.state.selection.empty && !editor.isActive("link")) {
      // No selection: insert the URL itself as linked text —
      // setLink on an empty range has no visible effect.
      editor
        .chain()
        .focus()
        .insertContent({
          type: "text",
          text: href,
          marks: [{ type: "link", attrs: { href } }],
        })
        .run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
  };

  const removeLink = () => {
    if (!editor) return;
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  };

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file || !editor) return;
    const reader = new FileReader();
    reader.onload = (evt) =>
      editor.chain().focus().setImage({ src: evt.target.result }).run();
    reader.readAsDataURL(file);
    e.target.value = "";
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
    "rounded-md px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50";
  const colorInputCls =
    "w-7 h-7 rounded-md border border-gray-300 dark:border-gray-700 cursor-pointer transition-colors hover:border-gray-400 dark:hover:border-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50";
  const menuItemCls =
    "w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent dark:disabled:hover:bg-transparent transition-colors";

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
    <div className="flex flex-wrap items-center gap-1">
      {/* History */}
      <div className="flex items-center gap-1">
        <button onClick={() => editor.chain().focus().undo().run()} className={btnBase} title="Undo" aria-label="Undo"><FaUndo /></button>
        <button onClick={() => editor.chain().focus().redo().run()} className={btnBase} title="Redo" aria-label="Redo"><FaRedo /></button>
      </div>

      <Divider />

      {/* Text */}
      <div className="flex items-center gap-1">
        <select
          onChange={(e) => setFontFamily(e.target.value)}
          value={s.fontFamily}
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
          className={btnBase}
          title="Clear Formatting"
          aria-label="Clear formatting"
        >
          <FaRemoveFormat />
        </button>
      </div>

      <Divider />

      {/* Formatting */}
      <div className="flex items-center gap-1">
        <button onClick={() => editor.chain().focus().toggleBold().run()} className={`${btnBase} ${s.bold ? `${activeBg} font-bold text-blue-600` : ""}`} title="Bold" aria-label="Bold"><FaBold /></button>
        <button onClick={() => editor.chain().focus().toggleItalic().run()} className={`${btnBase} ${s.italic ? `${activeBg} italic text-blue-600` : ""}`} title="Italic" aria-label="Italic"><FaItalic /></button>
        <button onClick={() => editor.chain().focus().toggleUnderline().run()} className={`${btnBase} ${s.underline ? `${activeBg} underline text-blue-600` : ""}`} title="Underline" aria-label="Underline"><FaUnderline /></button>
        <button onClick={() => editor.chain().focus().toggleStrike().run()} className={`${btnBase} ${s.strike ? `${activeBg} line-through text-blue-600` : ""}`} title="Strikethrough" aria-label="Strikethrough"><FaStrikethrough /></button>
        <button onClick={() => editor.chain().focus().toggleSubscript().run()} className={`${btnBase} ${s.subscript ? `${activeBg} text-blue-600` : ""}`} title="Subscript" aria-label="Subscript"><FaSubscript /></button>
        <button onClick={() => editor.chain().focus().toggleSuperscript().run()} className={`${btnBase} ${s.superscript ? `${activeBg} text-blue-600` : ""}`} title="Superscript" aria-label="Superscript"><FaSuperscript /></button>
        <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={`${btnBase} ${s.heading1 ? `${activeBg} font-bold text-purple-600` : ""}`} title="Heading 1" aria-label="Heading 1"><FaHeading /></button>
        <button onClick={() => editor.chain().focus().toggleBlockquote().run()} className={`${btnBase} ${s.blockquote ? `${activeBg} text-blue-600` : ""}`} title="Quote" aria-label="Quote"><FaQuoteRight /></button>
        <button onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={`${btnBase} ${s.codeBlock ? `${activeBg} text-yellow-600` : ""}`} title="Code" aria-label="Code block"><FaCode /></button>
      </div>

      <Divider />

      {/* Lists */}
      <div className="flex items-center gap-1">
        <button onClick={() => editor.chain().focus().toggleBulletList().run()} className={`${btnBase} ${s.bulletList ? `${activeBg} text-blue-600` : ""}`} title="Bullet List" aria-label="Bullet list"><FaListUl /></button>
        <button onClick={() => editor.chain().focus().toggleOrderedList().run()} className={`${btnBase} ${s.orderedList ? `${activeBg} text-blue-600` : ""}`} title="Numbered List" aria-label="Numbered list"><FaListOl /></button>
        <button onClick={() => editor.chain().focus().toggleTaskList().run()} className={`${btnBase} ${s.taskList ? `${activeBg} text-green-600` : ""}`} title="To-do List" aria-label="Task list"><FaCheckSquare /></button>
        <button onClick={indentListItem} disabled={!s.canIndent} className={`${btnBase} ${btnDisabled}`} title="Indent (Tab)" aria-label="Indent list item"><FaIndent /></button>
        <button onClick={outdentListItem} disabled={!s.canOutdent} className={`${btnBase} ${btnDisabled}`} title="Outdent (Shift+Tab)" aria-label="Outdent list item"><FaOutdent /></button>
      </div>

      <Divider />

      {/* Alignment */}
      <div className="flex items-center gap-1">
        <button onClick={() => editor.chain().focus().setTextAlign("left").run()} className={`${btnBase} ${s.alignLeft ? `${activeBg} text-blue-600` : ""}`} title="Align Left" aria-label="Align left"><FaAlignLeft /></button>
        <button onClick={() => editor.chain().focus().setTextAlign("center").run()} className={`${btnBase} ${s.alignCenter ? `${activeBg} text-blue-600` : ""}`} title="Align Centre" aria-label="Align centre"><FaAlignCenter /></button>
        <button onClick={() => editor.chain().focus().setTextAlign("right").run()} className={`${btnBase} ${s.alignRight ? `${activeBg} text-blue-600` : ""}`} title="Align Right" aria-label="Align right"><FaAlignRight /></button>
        <button onClick={() => editor.chain().focus().setTextAlign("justify").run()} className={`${btnBase} ${s.alignJustify ? `${activeBg} text-blue-600` : ""}`} title="Justify" aria-label="Justify"><FaAlignJustify /></button>
      </div>

      <Divider />

      {/* Insert */}
      <div className="flex items-center gap-1">
        <button
          onClick={editLink}
          className={`${btnBase} ${s.link ? `${activeBg} text-blue-600` : ""}`}
          title="Insert / Edit Link"
          aria-label="Insert or edit link"
        >
          <FaLink />
        </button>
        <button
          onClick={removeLink}
          disabled={!s.link}
          className={`${btnBase} ${btnDisabled}`}
          title="Remove Link"
          aria-label="Remove link"
        >
          <FaUnlink />
        </button>

        <input
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          ref={fileInputRef}
          onChange={handleImageUpload}
        />
        <button
          title="Insert Photo"
          aria-label="Insert photo"
          onClick={() => fileInputRef.current?.click()}
          className={btnBase}
        >
          <FaCamera />
        </button>

        <button
          onClick={() => {
            const url = window.prompt("Enter image URL");
            if (url) editor.chain().focus().setImage({ src: url }).run();
          }}
          className={btnBase}
          title="Insert Image by URL"
          aria-label="Insert image by URL"
        >
          <FaImage />
        </button>

        <button
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          className={btnBase}
          title="Horizontal Rule"
          aria-label="Insert horizontal rule"
        >
          <FaMinus />
        </button>

        <button
          onClick={() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
          className={btnBase}
          title="Table"
          aria-label="Insert table"
        >
          <FaTable />
        </button>

        <div className="relative" ref={tableMenuRef}>
          <button
            onClick={() => setTableMenuOpen((open) => !open)}
            disabled={!s.inTable}
            className={`${btnBase} ${btnDisabled} ${tableMenuOpen ? activeBg : ""} flex items-center`}
            title="Table Options"
            aria-label="Table options"
            aria-haspopup="menu"
            aria-expanded={tableMenuOpen}
          >
            <FaTable />
            <FaCaretDown className="ml-0.5 text-xs" />
          </button>
          {tableMenuOpen && s.inTable && (
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

      {/* Colours */}
      <div className="flex items-center gap-1">
        <input
          type="color"
          onInput={(e) => editor.chain().focus().setColor(e.target.value).run()}
          value={s.color}
          title="Text Color"
          aria-label="Text color"
          className={colorInputCls}
        />
        <input
          type="color"
          onInput={(e) =>
            editor.chain().focus().toggleHighlight({ color: e.target.value }).run()
          }
          value={s.highlightColor}
          title="Highlight Color"
          aria-label="Highlight color"
          className={colorInputCls}
        />
        <button onClick={() => editor.chain().focus().toggleHighlight().run()} className={`${btnBase} ${s.highlight ? "bg-yellow-300 dark:bg-yellow-300/80 text-gray-900" : ""}`} title="Highlight" aria-label="Highlight"><FaHighlighter /></button>
      </div>
    </div>
  );
}
