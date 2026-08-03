// src/components/ThreeDotMenu.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import ShareDialog from "./ShareDialog";
import { useAppState } from "../context/AppStateContext";
import { menuItemClass } from "../lib/interactionStyles";

export default function ThreeDotMenu({
  anchorRef, // Element OR ref to element
  onClose,
  options = [], // [{ label, icon, onClick, danger } or { type: "share", share:{...} } or { type: "separator" }]
  theme = "light", // "dark" | "light"
}) {
  // Only used to DEFAULT the Share / Export dialog's source when the note being
  // shared is the one currently open. The dialog always names its source.
  // `|| {}` because this is a generic presentational menu: it must stay usable
  // even where the app state provider is not above it.
  const { currentNoteId = null, activeNoteView = null } = useAppState() || {};
  const menuRef = useRef(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCfg, setShareCfg] = useState(null);

  // Fallback detection in case theme prop isn't passed correctly
  const isDark =
    theme === "dark" ||
    (typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"));

  // Normalize anchor (supports DOM node or ref.current)
  const anchorEl = useMemo(() => {
    return anchorRef?.current ? anchorRef.current : anchorRef || null;
  }, [anchorRef]);

  // Position below anchor
  useEffect(() => {
    function positionMenu() {
      if (anchorEl && menuRef.current) {
        const rect = anchorEl.getBoundingClientRect();
        const menu = menuRef.current;
        menu.style.position = "fixed";
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${Math.max(
          8,
          Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)
        )}px`;
        menu.style.zIndex = 9999;
      }
    }
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [anchorEl]);

  // Outside click
  useEffect(() => {
    function handleClick(e) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target) &&
        anchorEl &&
        !anchorEl.contains(e.target)
      ) {
        onClose?.();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, anchorEl]);

  // Escape closes
  useEffect(() => {
    function handleEsc(e) {
      if (e.key === "Escape") {
        if (shareOpen) setShareOpen(false);
        else onClose?.();
      }
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose, shareOpen]);

  const handleOptionClick = (opt) => {
    if (!opt) return;
    if (opt.type === "separator") return;
    if (opt.type === "share" && opt.share) {
      setShareCfg(opt.share);
      setShareOpen(true);
      return;
    }
    opt.onClick?.();
    onClose?.();
  };

  return (
    <>
      <div
        ref={menuRef}
        role="menu"
        className={`min-w-[180px] py-1 shadow-lg rounded-xl border absolute
          ${
            isDark
              ? "bg-[#232323] text-white border-[#333]"
              : "bg-white text-gray-900 border-gray-200"
          }`}
      >
        {options.map((opt, idx) => {
          if (opt.type === "separator") {
            return (
              <div
                key={`sep-${idx}`}
                className={`my-1 border-t ${
                  isDark ? "border-[#333]" : "border-gray-200"
                }`}
              />
            );
          }
          return (
            <button
              key={opt.label || idx}
              type="button"
              // Destructive rows keep the danger variant in every state — they
              // never pick up the turquoise interaction accent on hover, focus
              // or press. Non-destructive rows inherit the menu's own text
              // colour and take the shared hover surface.
              className={menuItemClass({
                danger: !!opt?.danger,
                className: `flex items-center gap-2 px-4 py-2 w-full text-left text-sm ${
                  idx === options.length - 1 ? "rounded-b-xl" : ""
                }`,
              })}
              onClick={() => handleOptionClick(opt)}
            >
              {/* The icon inherits the row's colour, so a destructive row's
                  icon and label can never disagree. */}
              {opt?.icon && <span className="text-current">{opt.icon}</span>}
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>

      {shareOpen && shareCfg && (
        <ShareDialog
          scopeTitle={shareCfg.scopeTitle || "Share / Export"}
          items={shareCfg.items || []}
          defaultSelection={shareCfg.defaultSelection || []}
          getNoteContent={shareCfg.getNoteContent}
          currentNoteId={currentNoteId}
          activeNoteView={activeNoteView}
          theme={isDark ? "dark" : "light"} // pass theme explicitly
          onClose={() => {
            setShareOpen(false);
            onClose?.();
          }}
        />
      )}
    </>
  );
}
