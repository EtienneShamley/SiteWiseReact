import React, { useRef, useState, useCallback } from "react";
import { FaDownload, FaChevronDown } from "react-icons/fa";
import useOutsideClose from "../../hooks/useOutsideClose";
import { exportPDF, exportDOCX, exportHTML, exportMD } from "../../lib/exportUtils";

export default function ExportMenu({ editor }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(ref, close);

  if (!editor) return null;

  const safeRun = (fn) => async () => {
    try { await fn(editor); }
    catch (e) { console.error("Export failed:", e); alert("Export failed. See console for details."); }
    finally { setOpen(false); }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded bg-white dark:bg-[#2a2a2a] text-black dark:text-white border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-[#3a3a3a]"
        title="Export"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <FaDownload />
        Export
        <FaChevronDown className="opacity-70" />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 mt-2 min-w-[220px] rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#232323] overflow-hidden z-50">
          <button role="menuitem" className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-[#333] text-gray-900 dark:text-gray-100" onClick={safeRun(exportPDF)}>
            Export as PDF (.pdf)
          </button>
          <button role="menuitem" className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-[#333] text-gray-900 dark:text-gray-100" onClick={safeRun(exportDOCX)}>
            Export as Word (.docx)
          </button>
          <button role="menuitem" className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-[#333] text-gray-900 dark:text-gray-100" onClick={safeRun(exportHTML)}>
            Export as HTML (.html)
          </button>
          <button role="menuitem" className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-[#333] text-gray-900 dark:text-gray-100" onClick={safeRun(exportMD)}>
            Export as Markdown (.md)
          </button>
        </div>
      )}
    </div>
  );
}
