import React, { useRef, useState, useEffect } from "react";
import {
  FaBold, FaItalic, FaUnderline, FaStrikethrough, FaListUl, FaListOl,
  FaCheckSquare, FaQuoteRight, FaCode, FaHighlighter, FaLink, FaImage,
  FaTable, FaUndo, FaRedo, FaHeading, FaCamera, FaDownload, FaChevronDown
} from "react-icons/fa";
import html2pdf from "html2pdf.js";
import htmlToDocx from "html-to-docx";
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
  const [showExport, setShowExport] = useState(false);
  const exportRef = useRef(null);

  // Close export menu on outside click / ESC
  useEffect(() => {
    function onClickOutside(e) {
      if (exportRef.current && !exportRef.current.contains(e.target)) {
        setShowExport(false);
      }
    }
    function onEsc(e) {
      if (e.key === "Escape") setShowExport(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  function handleImageUpload(e) {
    const file = e.target.files?.[0];
    if (file && editor) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        editor.chain().focus().setImage({ src: evt.target.result }).run();
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    }
  }

  // Helpers: font/size
  const setFontSize = (size) => editor?.chain().focus().setMark("textStyle", { fontSize: size }).run();
  const setFontFamily = (family) => editor?.chain().focus().setFontFamily(family).run();

  // ---------- EXPORT HELPERS ----------
  function safeFilename(base, ext) {
    const clean = (base || "sitewise-note")
      .toString()
      .replace(/[\\/:*?"<>|]+/g, " ")
      .trim()
      .slice(0, 80);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `${clean || "sitewise-note"}_${ts}.${ext}`;
  }

  function suggestedTitle() {
    if (!editor) return "sitewise-note";
    // Prefer first H1/H2, fallback to first 40 chars of text
    const html = editor.getHTML();
    const hMatch = html.match(/<h[12][^>]*>(.*?)<\/h[12]>/i);
    if (hMatch) {
      const tmp = document.createElement("div");
      tmp.innerHTML = hMatch[1];
      return tmp.textContent?.trim() || "sitewise-note";
    }
    const text = editor.getText().trim().replace(/\s+/g, " ");
    return text ? text.slice(0, 40) : "sitewise-note";
  }

  function getHTML() {
    if (!editor) return "<p></p>";
    // Force export on a white page with neutral styling (good for dark mode apps)
    return `
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            :root {
              --page-fg: #111;
              --muted: #555;
              --border: #ccc;
            }
            @page { size: A4; margin: 12mm; }
            * { box-sizing: border-box; }
            body { font-family: Arial, sans-serif; color: var(--page-fg); background: #fff; }
            .tiptap-content { max-width: 820px; margin: 0 auto; line-height: 1.5; font-size: 12pt; }
            img { max-width: 100%; height: auto; display: inline-block; }
            table { border-collapse: collapse; width: 100%; margin: 10px 0; }
            td, th { border: 1px solid var(--border); padding: 6px; vertical-align: top; }
            blockquote { border-left: 3px solid var(--muted); padding-left: 10px; color: var(--muted); margin: 8px 0; }
            code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 0.95em; }
            pre { background: #f5f5f5; padding: 8px; overflow: auto; }
            h1, h2, h3 { page-break-after: avoid; }
            .page-break { page-break-before: always; }
            /* Optional print tweaks */
            @media print {
              a { color: inherit; text-decoration: underline; }
            }
          </style>
        </head>
        <body>
          <div class="tiptap-content">
            ${editor.getHTML()}
          </div>
        </body>
      </html>
    `;
  }

  async function exportPDF() {
    if (!editor) return;
    try {
      const html = getHTML();
      const container = document.createElement("div");
      container.innerHTML = html;

      const opt = {
        margin: 10,
        filename: safeFilename(suggestedTitle(), "pdf"),
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
      };

      await html2pdf().from(container).set(opt).save();
    } catch (err) {
      console.error("PDF export failed:", err);
      alert("PDF export failed. Try again or check console for details.");
    } finally {
      setShowExport(false);
    }
  }

  async function exportDOCX() {
    if (!editor) return;
    try {
      const html = getHTML();
      const blob = await htmlToDocx(html, null, {
        table: { row: { cantSplit: true } },
        footer: true,
        pageNumber: true
      });

      const file = new Blob([blob], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });

      const a = document.createElement("a");
      const url = URL.createObjectURL(file);
      a.href = url;
      a.download = safeFilename(suggestedTitle(), "docx");
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("DOCX export failed:", err);
      alert("Word export failed. Try again or check console for details.");
    } finally {
      setShowExport(false);
    }
  }

  function exportHTML() {
    if (!editor) return;
    try {
      const html = getHTML();
      const file = new Blob([html], { type: "text/html;charset=utf-8" });

      const a = document.createElement("a");
      const url = URL.createObjectURL(file);
      a.href = url;
      a.download = safeFilename(suggestedTitle(), "html");
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("HTML export failed:", err);
      alert("HTML export failed. Try again or check console for details.");
    } finally {
      setShowExport(false);
    }
  }

  function exportMD() {
    if (!editor) return;
    try {
      const raw = editor.getHTML();
      const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
      td.use(gfm); // table/task list/link autolinks, etc.

      const md = td.turndown(raw);
      const file = new Blob([md], { type: "text/markdown;charset=utf-8" });

      const a = document.createElement("a");
      const url = URL.createObjectURL(file);
      a.href = url;
      a.download = safeFilename(suggestedTitle(), "md");
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("MD export failed:", err);
      alert("Markdown export failed. Try again or check console for details.");
    } finally {
      setShowExport(false);
    }
  }

  // Optional: print the editor content with export styles
  function exportPrint() {
    if (!editor) return;
    try {
      const html = getHTML();
      const w = window.open("", "_blank", "noopener,noreferrer");
      if (!w) return;
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
      // give styles a tick to paint, then print
      setTimeout(() => w.print(), 250);
    } catch (err) {
      console.error("Print failed:", err);
      alert("Print failed. Try again or check console for details.");
    } finally {
      setShowExport(false);
    }
  }
  // ------------------------------------

  if (!editor) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 bg-gray-100 dark:bg-[#222] p-2 rounded-t-lg border-b border-gray-300 dark:border-gray-700 mb-2">
      {/* LEFT: Formatting cluster */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Font Family */}
        <select
          onChange={e => setFontFamily(e.target.value)}
          value={editor.getAttributes('fontFamily').fontFamily || ""}
          className="rounded px-1 py-0.5 text-sm bg-white dark:bg-[#2a2a2a] text-black dark:text-white border border-gray-300 dark:border-gray-700"
          title="Font Family"
          aria-label="Font family"
        >
          <option value="">Font</option>
          {FONT_FAMILIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>

        {/* Font Size */}
        <select
          onChange={e => setFontSize(e.target.value)}
          value={editor.getAttributes('textStyle').fontSize || ""}
          className="rounded px-1 py-0.5 text-sm bg-white dark:bg-[#2a2a2a] text-black dark:text-white border border-gray-300 dark:border-gray-700"
          title="Font Size"
          aria-label="Font size"
        >
          <option value="">Size</option>
          {FONT_SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>

        {/* Text Color */}
        <input
          type="color"
          onInput={e => editor.chain().focus().setColor(e.target.value).run()}
          value={editor.getAttributes('textStyle').color || "#000000"}
          title="Text Color"
          aria-label="Text color"
          className="w-6 h-6 border border-gray-300 dark:border-gray-700 rounded"
          style={{ verticalAlign: "middle" }}
        />

        {/* Highlight/Background Color */}
        <input
          type="color"
          onInput={e => editor.chain().focus().toggleHighlight({ color: e.target.value }).run()}
          value={editor.getAttributes('highlight').color || "#FFFF00"}
          title="Highlight Color"
          aria-label="Highlight color"
          className="w-6 h-6 border border-gray-300 dark:border-gray-700 rounded"
          style={{ verticalAlign: "middle" }}
        />

        {/* Formatting buttons */}
        <button onClick={() => editor.chain().focus().toggleBold().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive('bold') ? 'font-bold text-blue-600' : ''}`} title="Bold" aria-label="Bold"><FaBold /></button>
        <button onClick={() => editor.chain().focus().toggleItalic().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive('italic') ? 'italic text-blue-600' : ''}`} title="Italic" aria-label="Italic"><FaItalic /></button>
        <button onClick={() => editor.chain().focus().toggleUnderline().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive('underline') ? 'underline text-blue-600' : ''}`} title="Underline" aria-label="Underline"><FaUnderline /></button>
        <button onClick={() => editor.chain().focus().toggleStrike().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive('strike') ? 'line-through text-blue-600' : ''}`} title="Strikethrough" aria-label="Strikethrough"><FaStrikethrough /></button>
        <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive('heading', { level: 1 }) ? 'font-bold text-purple-600' : ''}`} title="Heading 1" aria-label="Heading 1"><FaHeading /></button>
        <button onClick={() => editor.chain().focus().toggleBulletList().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive('bulletList') ? 'text-blue-600' : ''}`} title="Bullet List" aria-label="Bullet list"><FaListUl /></button>
        <button onClick={() => editor.chain().focus().toggleOrderedList().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive('orderedList') ? 'text-blue-600' : ''}`} title="Numbered List" aria-label="Numbered list"><FaListOl /></button>
        <button onClick={() => editor.chain().focus().toggleTaskList().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive('taskList') ? 'text-green-600' : ''}`} title="To-do List" aria-label="Task list"><FaCheckSquare /></button>
        <button onClick={() => editor.chain().focus().toggleBlockquote().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive('blockquote') ? 'text-blue-600' : ''}`} title="Quote" aria-label="Quote"><FaQuoteRight /></button>
        <button onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive('codeBlock') ? 'text-yellow-600' : ''}`} title="Code" aria-label="Code block"><FaCode /></button>
        <button onClick={() => editor.chain().focus().toggleHighlight().run()} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${editor.isActive('highlight') ? 'bg-yellow-300' : ''}`} title="Highlight" aria-label="Highlight"><FaHighlighter /></button>

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
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          title="Table"
          aria-label="Insert table"
        >
          <FaTable />
        </button>

        {/* Undo/Redo */}
        <button onClick={() => editor.chain().focus().undo().run()} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700" title="Undo" aria-label="Undo"><FaUndo /></button>
        <button onClick={() => editor.chain().focus().redo().run()} className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700" title="Redo" aria-label="Redo"><FaRedo /></button>
      </div>

      {/* RIGHT: Export menu */}
      <div className="relative" ref={exportRef}>
        <button
          onClick={() => setShowExport((s) => !s)}
          className="flex items-center gap-2 px-3 py-1.5 rounded bg-white dark:bg-[#2a2a2a] text-black dark:text-white border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-[#3a3a3a]"
          title="Export"
          aria-haspopup="menu"
          aria-expanded={showExport}
        >
          <FaDownload />
          Export
          <FaChevronDown className="opacity-70" />
        </button>

        {showExport && (
          <div
            role="menu"
            className="absolute right-0 mt-2 min-w-[220px] rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#232323] overflow-hidden z-50"
          >
            <button role="menuitem"
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-[#333] text-gray-900 dark:text-gray-100"
              onClick={exportPDF}
            >
              Export as PDF (.pdf)
            </button>
            <button role="menuitem"
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-[#333] text-gray-900 dark:text-gray-100"
              onClick={exportDOCX}
            >
              Export as Word (.docx)
            </button>
            <button role="menuitem"
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-[#333] text-gray-900 dark:text-gray-100"
              onClick={exportHTML}
            >
              Export as HTML (.html)
            </button>
            <button role="menuitem"
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-[#333] text-gray-900 dark:text-gray-100"
              onClick={exportMD}
            >
              Export as Markdown (.md)
            </button>
            {/* Optional: print current note (uses export HTML, not app chrome) */}
            {/* <button role="menuitem"
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-[#333] text-gray-900 dark:text-gray-100"
              onClick={exportPrint}
            >
              Print…
            </button> */}
          </div>
        )}
      </div>
    </div>
  );
}
