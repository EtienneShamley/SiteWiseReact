// src/components/template/PhotoPreviewDialog.js
//
// Simple larger-photo preview, following the app's existing overlay/modal
// conventions (TemplateBuilderModal): fixed dim overlay, panel on top, Close
// button, plus Escape-to-close and dialog labeling. No editing or annotation.
//
// The object URL is OWNED by the PhotoAttachment that opened this dialog (via
// useAssetObjectUrl) — the dialog only borrows it, so there is nothing to
// revoke here and the URL cannot leak or outlive its owner.
import React, { useEffect, useRef } from "react";

export default function PhotoPreviewDialog({ url, name, onClose }) {
  const closeRef = useRef(null);

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

  // Move focus into the dialog so Escape/Enter act on it immediately.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-label={`Photo preview: ${name || "photo"}`}
      onClick={onClose}
    >
      <div
        className="relative flex flex-col items-center gap-3 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={url}
          alt={name || "Photo preview"}
          className="max-w-[92vw] max-h-[85vh] object-contain rounded bg-white"
        />
        <button
          ref={closeRef}
          type="button"
          className="px-3 py-1 border rounded text-black dark:text-white bg-white dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
