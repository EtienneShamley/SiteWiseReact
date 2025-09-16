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

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Font Family */}
      <select
        onChange={(e) => setFontFamily(e.target.value)}
        value={editor.getAttributes("fontFamily").fontFamily || ""}
        className="rounded px-1 py-0.5 text-sm bg-white dark:bg-[#2a2a2a] text-black dark:text-white border border-gray-300 dark:border-gray-700"
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
        className="rounded px-1 py-0.5 text-sm bg-white dark:bg-[#2a2a2a] text-black dark:text-white border border-gray-300 dark:border-gray-700"
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
        className="w-6 h-6 border border-gray-300 dark:border-gray-700 rounded"
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
        className="w-6 h-6 border border-gray-300 dark:border-gray-700 rounded"
      />

      {/* Formatting buttons */}
      <button onClick={() => editor.chain().focus().toggleBold().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive("bold") ? "font-bold text-blue-600" : ""}`} title="Bold" aria-label="Bold"><FaBold /></button>
      <button onClick={() => editor.chain().focus().toggleItalic().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive("italic") ? "italic text-blue-600" : ""}`} title="Italic" aria-label="Italic"><FaItalic /></button>
      <button onClick={() => editor.chain().focus().toggleUnderline().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive("underline") ? "underline text-blue-600" : ""}`} title="Underline" aria-label="Underline"><FaUnderline /></button>
      <button onClick={() => editor.chain().focus().toggleStrike().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive("strike") ? "line-through text-blue-600" : ""}`} title="Strikethrough" aria-label="Strikethrough"><FaStrikethrough /></button>
      <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive("heading", { level: 1 }) ? "font-bold text-purple-600" : ""}`} title="Heading 1" aria-label="Heading 1"><FaHeading /></button>
      <button onClick={() => editor.chain().focus().toggleBulletList().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive("bulletList") ? "text-blue-600" : ""}`} title="Bullet List" aria-label="Bullet list"><FaListUl /></button>
      <button onClick={() => editor.chain().focus().toggleOrderedList().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive("orderedList") ? "text-blue-600" : ""}`} title="Numbered List" aria-label="Numbered list"><FaListOl /></button>
      <button onClick={() => editor.chain().focus().toggleTaskList().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive("taskList") ? "text-green-600" : ""}`} title="To-do List" aria-label="Task list"><FaCheckSquare /></button>
      <button onClick={() => editor.chain().focus().toggleBlockquote().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive("blockquote") ? "text-blue-600" : ""}`} title="Quote" aria-label="Quote"><FaQuoteRight /></button>
      <button onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive("codeBlock") ? "text-yellow-600" : ""}`} title="Code" aria-label="Code block"><FaCode /></button>
      <button onClick={() => editor.chain().focus().toggleHighlight().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive("highlight") ? "bg-yellow-300" : ""}`} title="Highlight" aria-label="Highlight"><FaHighlighter /></button>

      {/* Link */}
      <button
        onClick={() => {
          const url = window.prompt("Enter URL");
          if (url) editor.chain().focus().setLink({ href: url }).run();
        }}
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
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
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
      >
        <FaCamera />
      </button>

      {/* Image by URL */}
      <button
        onClick={() => {
          const url = window.prompt("Enter image URL");
          if (url) editor.chain().focus().setImage({ src: url }).run();
        }}
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
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
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
        title="Table"
        aria-label="Insert table"
      >
        <FaTable />
      </button>

      {/* Undo / Redo */}
      <button onClick={() => editor.chain().focus().undo().run()} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700" title="Undo" aria-label="Undo"><FaUndo /></button>
      <button onClick={() => editor.chain().focus().redo().run()} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700" title="Redo" aria-label="Redo"><FaRedo /></button>
    </div>
  );
}
