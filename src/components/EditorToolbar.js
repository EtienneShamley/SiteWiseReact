import React, { useRef } from "react";
import {
  FaBold, FaItalic, FaUnderline, FaStrikethrough, FaListUl, FaListOl,
  FaCheckSquare, FaQuoteRight, FaCode, FaHighlighter, FaLink, FaImage,
  FaTable, FaUndo, FaRedo, FaHeading, FaMicrophone, FaFilePdf, FaPlus, FaCamera
} from "react-icons/fa";

export default function EditorToolbar({ editor }) {
  const fileInputRef = useRef();

  function handleImageUpload(e) {
    const file = e.target.files[0];
    if (file && editor) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        editor.chain().focus().setImage({ src: evt.target.result }).run();
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    }
  }

  if (!editor) return null;
  return (
    <div className="flex items-center gap-2 bg-gray-100 dark:bg-[#222] p-2 rounded-t-lg border-b border-gray-300 dark:border-gray-700 mb-2">
      {/* Basic Styles */}
      <button onClick={() => editor.chain().focus().toggleBold().run()} className={editor.isActive('bold') ? 'font-bold text-blue-600' : ''} title="Bold"><FaBold /></button>
      <button onClick={() => editor.chain().focus().toggleItalic().run()} className={editor.isActive('italic') ? 'italic text-blue-600' : ''} title="Italic"><FaItalic /></button>
      <button onClick={() => editor.chain().focus().toggleUnderline().run()} className={editor.isActive('underline') ? 'underline text-blue-600' : ''} title="Underline"><FaUnderline /></button>
      <button onClick={() => editor.chain().focus().toggleStrike().run()} className={editor.isActive('strike') ? 'line-through text-blue-600' : ''} title="Strikethrough"><FaStrikethrough /></button>

      {/* Headings */}
      <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={editor.isActive('heading', { level: 1 }) ? 'font-bold text-purple-600' : ''} title="Heading 1"><FaHeading /></button>

      {/* Lists & Tasks */}
      <button onClick={() => editor.chain().focus().toggleBulletList().run()} className={editor.isActive('bulletList') ? 'text-blue-600' : ''} title="Bullet List"><FaListUl /></button>
      <button onClick={() => editor.chain().focus().toggleOrderedList().run()} className={editor.isActive('orderedList') ? 'text-blue-600' : ''} title="Numbered List"><FaListOl /></button>
      <button onClick={() => editor.chain().focus().toggleTaskList().run()} className={editor.isActive('taskList') ? 'text-green-600' : ''} title="To-do List"><FaCheckSquare /></button>

      {/* Block, Code, Highlight */}
      <button onClick={() => editor.chain().focus().toggleBlockquote().run()} className={editor.isActive('blockquote') ? 'text-blue-600' : ''} title="Quote"><FaQuoteRight /></button>
      <button onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={editor.isActive('codeBlock') ? 'text-yellow-600' : ''} title="Code"><FaCode /></button>
      <button onClick={() => editor.chain().focus().toggleHighlight().run()} className={editor.isActive('highlight') ? 'bg-yellow-300' : ''} title="Highlight"><FaHighlighter /></button>

      {/* Link */}
      <button onClick={() => {
        const url = window.prompt("Enter URL");
        if (url) editor.chain().focus().setLink({ href: url }).run();
      }} title="Link"><FaLink /></button>

      {/* Image */}
      <input
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        ref={fileInputRef}
        onChange={handleImageUpload}
      />
      <button
        title="Insert Photo"
        onClick={() => fileInputRef.current.click()}
        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
      >
        <FaCamera />
      </button>
      {/* Insert by URL */}
      <button onClick={() => {
        const url = window.prompt("Enter image URL");
        if (url) editor.chain().focus().setImage({ src: url }).run();
      }} title="Insert Image by URL"><FaImage /></button>

      {/* Table */}
      <button onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title="Table"><FaTable /></button>
      {/* Undo/Redo */}
      <button onClick={() => editor.chain().focus().undo().run()} title="Undo"><FaUndo /></button>
      <button onClick={() => editor.chain().focus().redo().run()} title="Redo"><FaRedo /></button>

      {/* Voice & PDF placeholders */}
      <span className="ml-2" />
      <button onClick={() => alert("Voice recording (coming soon)")} title="Voice Note"><FaMicrophone /></button>
      <button onClick={() => alert("PDF Upload (coming soon)")} title="Insert PDF"><FaFilePdf /></button>
    </div>
  );
}
