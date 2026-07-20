// src/components/PdfLibrary.js
//
// The global PDF library — the top-level "PDFs" workspace. Lists all standalone
// PDF documents (independent of any project/folder/note), with upload, open,
// rename and delete. Opening a PDF hands off to the canonical PdfEditorTab via
// currentPdfId. No project/folder/note is required or created here.
import React, { useRef, useState } from "react";
import { FaEllipsisV, FaPen, FaTrash, FaFilePdf } from "react-icons/fa";
import { useAppState } from "../context/AppStateContext";
import { useTheme } from "../context/ThemeContext";
import ThreeDotMenu from "./ThreeDotMenu";

function metaLine(doc) {
  const when = doc?.updatedAt || doc?.createdAt;
  if (!when) return "PDF";
  try {
    return `Updated ${new Date(when).toLocaleString()}`;
  } catch {
    return "PDF";
  }
}

export default function PdfLibrary() {
  const { listAllPdfs, createGlobalPdf, renamePdf, deletePdf, setCurrentPdfId } =
    useAppState();
  const { theme } = useTheme();

  const inputRef = useRef(null);
  const rowRefs = useRef({});
  const [menuId, setMenuId] = useState(null);

  const pdfs = typeof listAllPdfs === "function" ? listAllPdfs() : [];

  const onUpload = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const doc = await createGlobalPdf(f);
    if (doc) setCurrentPdfId(doc.id);
  };

  return (
    <main className="flex-1 flex flex-col min-h-screen p-4 gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-gray-900 dark:text-white">
            PDFs
          </h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Standalone documents — available without a project, folder or note.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          onChange={onUpload}
          className="hidden"
        />
        <button
          className="nw-seg nw-seg--active px-3 py-1.5 rounded-md text-sm"
          onClick={() => inputRef.current?.click()}
        >
          + Upload PDF
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto border border-gray-300 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 shadow-sm p-3">
        {pdfs.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-sm px-6">
              <FaFilePdf className="mx-auto mb-3 text-2xl text-gray-400 dark:text-gray-500" />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No PDFs yet. Upload one to open and annotate it — no note required.
              </p>
            </div>
          </div>
        ) : (
          <ul className="space-y-2 text-sm">
            {pdfs.map((pdf) => (
              <li
                key={pdf.id}
                className="nw-nav-item group flex items-center gap-3 rounded-xl px-3 py-3 cursor-pointer"
                onClick={() => setCurrentPdfId(pdf.id)}
              >
                <FaFilePdf className="nw-nav-icon shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-gray-900 dark:text-white" title={pdf.name}>
                    {pdf.name}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {metaLine(pdf)}
                  </div>
                </div>
                <button
                  ref={(el) => (rowRefs.current[pdf.id] = el)}
                  className="ml-2 p-1.5 rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-black dark:hover:text-white transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuId(pdf.id);
                  }}
                >
                  <FaEllipsisV />
                </button>
                {menuId === pdf.id && (
                  <ThreeDotMenu
                    anchorRef={rowRefs.current[pdf.id]}
                    onClose={() => setMenuId(null)}
                    options={[
                      {
                        icon: <FaPen className="mr-2" />,
                        label: "Rename",
                        onClick: () => { renamePdf(pdf.id); setMenuId(null); },
                      },
                      {
                        icon: <FaTrash className="mr-2" />,
                        label: "Delete",
                        onClick: () => { deletePdf(pdf.id); setMenuId(null); },
                        danger: true,
                      },
                    ]}
                    theme={theme}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
