import React, { useRef } from "react";
import {
  FaBold, FaItalic, FaUnderline, FaStrikethrough, FaListUl, FaListOl,
  FaCheckSquare, FaQuoteRight, FaCode, FaHighlighter, FaLink, FaImage,
  FaTable, FaUndo, FaRedo, FaHeading, FaCamera
} from "react-icons/fa";
import { FONT_FAMILIES, FONT_SIZES } from "../../constants/editorOptions";

export default function FormattingControls({ editor }) {
  const fileInputRef = useRef();

  // Font size: default to 1em when blank (prevents empty mark attrs lingering)
  const setFontSize = (size) => {
    if (!editor) return;
    const val = size || "1em";
    editor.chain().focus().setMark("textStyle", { fontSize: val }).run();
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

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file || !editor) return;
    const reader = new FileReader();
    reader.onload = (evt) =>
      editor.chain().focus().setImage({ src: evt.target.result }).run();
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  if (!editor) return null;

  // Shared visual language for every toolbar control: neutral gray hover,
  // smooth transitions, and a focus-visible ring for keyboard use.
  const btnBase =
    "p-2 rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50";
  const activeBg = "bg-gray-200 dark:bg-gray-700";
  const selectCls =
    "rounded-md px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50";
  const colorInputCls =
    "w-7 h-7 rounded-md border border-gray-300 dark:border-gray-700 cursor-pointer transition-colors hover:border-gray-400 dark:hover:border-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-blue-500/50";

  return (
    <div className="flex flex-wrap items-center gap-1">
      {/* Font Family */}
      <select
        onChange={(e) => setFontFamily(e.target.value)}
        value={editor.getAttributes("fontFamily").fontFamily || ""}
        className={selectCls}
        title="Font Family"
        aria-label="Font family"
      >
        <option value="">Font</option>
        {FONT_FAMILIES.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>

      {/* Font Size */}
      <select
        onChange={(e) => setFontSize(e.target.value)}
        value={editor.getAttributes("textStyle").fontSize || ""}
        className={selectCls}
        title="Font Size"
        aria-label="Font size"
      >
        <option value="">Size</option>
        {FONT_SIZES.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>

      {/* Text Color */}
      <input
        type="color"
        onInput={(e) => editor.chain().focus().setColor(e.target.value).run()}
        value={editor.getAttributes("textStyle").color || "#000000"}
        title="Text Color"
        aria-label="Text color"
        className={colorInputCls}
      />

      {/* Highlight Color */}
      <input
        type="color"
        onInput={(e) =>
          editor.chain().focus().toggleHighlight({ color: e.target.value }).run()
        }
        value={editor.getAttributes("highlight").color || "#FFFF00"}
        title="Highlight Color"
        aria-label="Highlight color"
        className={colorInputCls}
      />

      {/* Formatting buttons */}
      <button onClick={() => editor.chain().focus().toggleBold().run()} className={`${btnBase} ${editor.isActive("bold") ? `${activeBg} font-bold text-blue-600` : ""}`} title="Bold" aria-label="Bold"><FaBold /></button>
      <button onClick={() => editor.chain().focus().toggleItalic().run()} className={`${btnBase} ${editor.isActive("italic") ? `${activeBg} italic text-blue-600` : ""}`} title="Italic" aria-label="Italic"><FaItalic /></button>
      <button onClick={() => editor.chain().focus().toggleUnderline().run()} className={`${btnBase} ${editor.isActive("underline") ? `${activeBg} underline text-blue-600` : ""}`} title="Underline" aria-label="Underline"><FaUnderline /></button>
      <button onClick={() => editor.chain().focus().toggleStrike().run()} className={`${btnBase} ${editor.isActive("strike") ? `${activeBg} line-through text-blue-600` : ""}`} title="Strikethrough" aria-label="Strikethrough"><FaStrikethrough /></button>
      <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={`${btnBase} ${editor.isActive("heading", { level: 1 }) ? `${activeBg} font-bold text-purple-600` : ""}`} title="Heading 1" aria-label="Heading 1"><FaHeading /></button>
      <button onClick={() => editor.chain().focus().toggleBulletList().run()} className={`${btnBase} ${editor.isActive("bulletList") ? `${activeBg} text-blue-600` : ""}`} title="Bullet List" aria-label="Bullet list"><FaListUl /></button>
      <button onClick={() => editor.chain().focus().toggleOrderedList().run()} className={`${btnBase} ${editor.isActive("orderedList") ? `${activeBg} text-blue-600` : ""}`} title="Numbered List" aria-label="Numbered list"><FaListOl /></button>
      <button onClick={() => editor.chain().focus().toggleTaskList().run()} className={`${btnBase} ${editor.isActive("taskList") ? `${activeBg} text-green-600` : ""}`} title="To-do List" aria-label="Task list"><FaCheckSquare /></button>
      <button onClick={() => editor.chain().focus().toggleBlockquote().run()} className={`${btnBase} ${editor.isActive("blockquote") ? `${activeBg} text-blue-600` : ""}`} title="Quote" aria-label="Quote"><FaQuoteRight /></button>
      <button onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={`${btnBase} ${editor.isActive("codeBlock") ? `${activeBg} text-yellow-600` : ""}`} title="Code" aria-label="Code block"><FaCode /></button>
      <button onClick={() => editor.chain().focus().toggleHighlight().run()} className={`${btnBase} ${editor.isActive("highlight") ? "bg-yellow-300 dark:bg-yellow-300/80 text-gray-900" : ""}`} title="Highlight" aria-label="Highlight"><FaHighlighter /></button>

      {/* Link */}
      <button
        onClick={() => {
          const url = window.prompt("Enter URL");
          if (url) editor.chain().focus().setLink({ href: url }).run();
        }}
        className={btnBase}
        title="Link"
        aria-label="Insert link"
      >
        <FaLink />
      </button>

      {/* Image Upload (hidden input) */}
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

      {/* Image by URL */}
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

      {/* Table */}
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

      {/* Undo / Redo */}
      <button onClick={() => editor.chain().focus().undo().run()} className={btnBase} title="Undo" aria-label="Undo"><FaUndo /></button>
      <button onClick={() => editor.chain().focus().redo().run()} className={btnBase} title="Redo" aria-label="Redo"><FaRedo /></button>
    </div>
  );
}
