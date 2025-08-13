// src/components/EditorToolbar.js
import React, { useRef } from "react";
import {
  FaBold, FaItalic, FaUnderline, FaStrikethrough, FaListUl, FaListOl,
  FaCheckSquare, FaQuoteRight, FaCode, FaHighlighter, FaLink, FaImage,
  FaTable, FaUndo, FaRedo, FaHeading, FaFilePdf, FaCamera,
  FaDownload, FaPrint, FaFont, FaPalette
} from "react-icons/fa";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const FONT_SIZES = [
  { label: "Small", value: "0.875em" },
  { label: "Normal", value: "1em" },
  { label: "Large", value: "1.25em" },
  { label: "Huge", value: "1.5em" }
];

const FONT_FAMILIES = [
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Tahoma", value: "Tahoma, sans-serif" },
  { label: "Times New Roman", value: "'Times New Roman', serif" },
  { label: "Verdana", value: "Verdana, sans-serif" }
];

export default function EditorToolbar({ editor }) {
  const fileInputRef = useRef();

  if (!editor) return null;

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

  // Set font size using TextStyle
  const setFontSize = (size) => {
    editor.chain().focus().setMark("textStyle", { fontSize: size }).run();
  };

  // Set font family using FontFamily
  const setFontFamily = (family) => {
    editor.chain().focus().setFontFamily(family).run();
  };

  // ------- Export helpers -------
  const getNoteTitle = () => {
    // Try to read first heading, else fallback
    const h1 = editor.getText({ from: 1, to: Math.min(200, editor.state.doc.content.size) });
    // very rough; you could wire the actual note title down as a prop if needed
    return (h1 && h1.trim()) ? h1.split("\n")[0].slice(0, 40) : "sitewise-note";
  };

  const downloadFile = (filename, mime, content) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  };

  const exportHTML = () => {
    const title = getNoteTitle().replace(/[^\w\- ]+/g, "").trim() || "sitewise-note";
    const html = editor.getHTML();
    const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ddd; padding: 8px; }
  pre { background:#f6f8fa; padding:12px; overflow:auto; }
</style>
</head>
<body>
${html}
</body>
</html>`;
    downloadFile(`${title}.html`, "text/html;charset=utf-8", page);
  };

  const exportMarkdown = () => {
    const title = getNoteTitle().replace(/[^\w\- ]+/g, "").trim() || "sitewise-note";
    const html = editor.getHTML();
    const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    turndown.use(gfm);
    const md = turndown.turndown(html);
    downloadFile(`${title}.md`, "text/markdown;charset=utf-8", md);
  };

  const printDoc = () => {
    const html = editor.getHTML();
    const win = window.open("", "_blank", "noopener,noreferrer");
    if (!win) return;
    win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Print</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; color: #111; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ddd; padding: 8px; }
  pre { background:#f6f8fa; padding:12px; overflow:auto; }
  @page { margin: 20mm; }
</style>
</head>
<body>
${html}
<script>window.addEventListener('load', () => { window.print(); setTimeout(() => window.close(), 300); });</script>
</body>
</html>`);
    win.document.close();
  };

  return (
    <div className="flex flex-wrap items-center gap-2 bg-gray-100 dark:bg-[#222] p-2 rounded-t-lg border-b border-gray-300 dark:border-gray-700 mb-2">
      {/* Font Family */}
      <label className="flex items-center gap-1 text-xs opacity-70"><FaFont />
        <select
          onChange={e => setFontFamily(e.target.value)}
          value={editor.getAttributes('fontFamily').fontFamily || ""}
          className="rounded px-1 py-0.5 text-sm bg-white dark:bg-[#333] text-black dark:text-white"
          title="Font Family"
        >
          <option value="">Font</option>
          {FONT_FAMILIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </label>

      {/* Font Size */}
      <label className="flex items-center gap-1 text-xs opacity-70"><FaFont />
        <select
          onChange={e => setFontSize(e.target.value)}
          value={editor.getAttributes('textStyle').fontSize || ""}
          className="rounded px-1 py-0.5 text-sm bg-white dark:bg-[#333] text-black dark:text-white"
          title="Font Size"
        >
          <option value="">Size</option>
          {FONT_SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </label>

      {/* Text Color */}
      <label className="flex items-center gap-1 text-xs opacity-70"><FaPalette />
        <input
          type="color"
          onInput={e => editor.chain().focus().setColor(e.target.value).run()}
          value={editor.getAttributes('textStyle').color || "#000000"}
          title="Text Color"
          className="w-6 h-6 bg-transparent"
          style={{ verticalAlign: "middle" }}
        />
      </label>

      {/* Highlight Color */}
      <label className="flex items-center gap-1 text-xs opacity-70"><FaHighlighter />
        <input
          type="color"
          onInput={e => editor.chain().focus().toggleHighlight({ color: e.target.value }).run()}
          value={editor.getAttributes('highlight').color || "#FFFF00"}
          title="Highlight Color"
          className="w-6 h-6 bg-transparent"
          style={{ verticalAlign: "middle" }}
        />
      </label>

      {/* Formatting */}
      <button onClick={() => editor.chain().focus().toggleBold().run()} className={editor.isActive('bold') ? 'font-bold text-blue-600' : ''} title="Bold"><FaBold /></button>
      <button onClick={() => editor.chain().focus().toggleItalic().run()} className={editor.isActive('italic') ? 'italic text-blue-600' : ''} title="Italic"><FaItalic /></button>
      <button onClick={() => editor.chain().focus().toggleUnderline().run()} className={editor.isActive('underline') ? 'underline text-blue-600' : ''} title="Underline"><FaUnderline /></button>
      <button onClick={() => editor.chain().focus().toggleStrike().run()} className={editor.isActive('strike') ? 'line-through text-blue-600' : ''} title="Strikethrough"><FaStrikethrough /></button>
      <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={editor.isActive('heading', { level: 1 }) ? 'font-bold text-purple-600' : ''} title="Heading 1"><FaHeading /></button>
      <button onClick={() => editor.chain().focus().toggleBulletList().run()} className={editor.isActive('bulletList') ? 'text-blue-600' : ''} title="Bullet List"><FaListUl /></button>
      <button onClick={() => editor.chain().focus().toggleOrderedList().run()} className={editor.isActive('orderedList') ? 'text-blue-600' : ''} title="Numbered List"><FaListOl /></button>
      <button onClick={() => editor.chain().focus().toggleTaskList().run()} className={editor.isActive('taskList') ? 'text-green-600' : ''} title="To-do List"><FaCheckSquare /></button>
      <button onClick={() => editor.chain().focus().toggleBlockquote().run()} className={editor.isActive('blockquote') ? 'text-blue-600' : ''} title="Quote"><FaQuoteRight /></button>
      <button onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={editor.isActive('codeBlock') ? 'text-yellow-600' : ''} title="Code"><FaCode /></button>
      <button onClick={() => editor.chain().focus().toggleHighlight().run()} className={editor.isActive('highlight') ? 'bg-yellow-300' : ''} title="Highlight"><FaHighlighter /></button>

      {/* Link */}
      <button onClick={() => {
        const url = window.prompt("Enter URL");
        if (url) editor.chain().focus().setLink({ href: url }).run();
      }} title="Link"><FaLink /></button>

      {/* Image Upload */}
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

      {/* ---- Export / Print ---- */}
      <div className="ml-auto flex items-center gap-2">
        <button onClick={exportMarkdown} title="Export as Markdown (.md)" className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center gap-1">
          <FaDownload /><span className="text-xs">MD</span>
        </button>
        <button onClick={exportHTML} title="Export as HTML (.html)" className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 flex items-center gap-1">
          <FaDownload /><span className="text-xs">HTML</span>
        </button>
        <button onClick={printDoc} title="Print" className="px-2 py-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700">
          <FaPrint />
        </button>
        {/* keep PDF icon as placeholder if you want */}
        <button onClick={() => alert("PDF Upload (coming soon)")} title="Insert PDF">
          <FaFilePdf />
        </button>
      </div>
    </div>
  );
}
