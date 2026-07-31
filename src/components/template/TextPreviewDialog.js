// src/components/template/TextPreviewDialog.js
//
// Controlled plain-text preview for TXT/CSV attachments, following the app's
// existing overlay/modal conventions (TemplateBuilderModal / PhotoPreviewDialog):
// dim overlay, panel, Close button, Escape-to-close, dialog labeling.
//
// SECURITY: the file's contents are read with blob.text() and rendered as
// ESCAPED React text inside <pre>. React escapes text children, so markup in
// the file is displayed literally and never parsed as HTML.
// dangerouslySetInnerHTML is never used here, and the file is never navigated
// to as a document (which would make it same-origin) — see
// src/lib/safeAttachmentOpen.js.
import React, { useEffect, useRef, useState } from "react";

// Guard against locking up the UI on a very large text file; the full file
// remains available through Download.
const MAX_PREVIEW_CHARS = 200000;

export default function TextPreviewDialog({ blob, name, onClose }) {
  const [state, setState] = useState({ status: "loading", text: "" });
  const closeRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    blob
      .text()
      .then((text) => {
        if (cancelled) return;
        const truncated = text.length > MAX_PREVIEW_CHARS;
        setState({
          status: "ready",
          text: truncated ? text.slice(0, MAX_PREVIEW_CHARS) : text,
          truncated,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", text: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [blob]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-label={`Text preview: ${name || "file"}`}
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-xl w-[80vw] max-w-3xl h-[80vh] shadow-xl border border-gray-300 dark:border-gray-700 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center px-4 py-2 border-b border-gray-300 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-black dark:text-white truncate" title={name}>
            {name || "Text preview"}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="px-3 py-1 border rounded text-black dark:text-white bg-white dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {state.status === "loading" && (
            <div className="text-sm text-gray-600 dark:text-gray-300" role="status">
              Loading preview…
            </div>
          )}
          {state.status === "error" && (
            <div className="text-sm text-red-700 dark:text-red-400" role="alert">
              This file could not be read.
            </div>
          )}
          {state.status === "ready" && (
            <>
              {/* React escapes text children — file contents are never parsed
                  as markup. */}
              <pre className="text-xs whitespace-pre-wrap break-words text-black dark:text-white font-mono">
                {state.text}
              </pre>
              {state.truncated && (
                <div className="mt-3 text-xs text-gray-600 dark:text-gray-300">
                  Preview truncated. Download the file to see all of it.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
