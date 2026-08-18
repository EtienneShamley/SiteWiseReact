// src/components/ThreeDotMenu.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

  // An explicit theme prop is an OVERRIDE, not a hint: callers that render on
  // the document's white paper (Template Builder row actions, the row-level
  // AI refine trigger) pass theme="light" specifically so this popover stays
  // light-locked even while the rest of the app is in dark theme — see
  // pagedDocument.css's "paper stays white even in dark mode" rule. Only a
  // caller that passes no theme at all falls back to auto-detecting the real
  // app theme, which is every other call site.
  const isDark =
    theme === "dark"
      ? true
      : theme === "light"
      ? false
      : typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark");

  // `.nw-menu-item` (nav.css) reads its hover/disabled/danger colours from
  // CSS custom properties that cascade from the app's real `.dark` class on
  // <html> — the `isDark` boolean above only controls this component's own
  // inline Tailwind classes, not that cascade. Forcing light therefore also
  // needs these specific properties shadowed on the popover's own root, so
  // its rows render light-locked too, not just its background/border.
  const lightLockVars =
    theme === "light"
      ? {
          "--nw-state-hover-text": "#0f172a",
          "--nw-state-hover-bg": "rgba(15, 23, 42, 0.06)",
          "--nw-state-disabled-text": "#94a3b8",
          "--nw-danger-text": "#dc2626",
          "--nw-danger-hover-bg": "rgba(220, 38, 38, 0.10)",
          "--nw-focus-ring": "rgba(11, 110, 120, 0.90)",
        }
      : undefined;

  // Normalize anchor (supports DOM node or ref.current)
  const anchorEl = useMemo(() => {
    return anchorRef?.current ? anchorRef.current : anchorRef || null;
  }, [anchorRef]);

  // Position below the anchor, in VIEWPORT coordinates.
  //
  // The popover is rendered through a portal on <body> (see the return below)
  // rather than beside its trigger. That is what keeps `position: fixed`
  // honest under DOCUMENT ZOOM: the note document is drawn inside a CSS
  // `zoom`ed subtree (MainArea's `.nw-doc-zoom`, src/lib/documentZoom.js), and a
  // fixed-position element INSIDE that subtree has its lengths multiplied by
  // the zoom — so a menu placed at the trigger's client rect landed 25–50%
  // too far down and right at 125–150%, often off screen, which read as "the
  // menu disappeared". On <body> the client rect (visual pixels) and the
  // fixed coordinates agree at every zoom level. It also keeps the menu above
  // any overflow-clipping ancestor. Anchor rect and hit-testing are unaffected.
  useEffect(() => {
    function positionMenu() {
      if (anchorEl && menuRef.current) {
        const rect = anchorEl.getBoundingClientRect();
        const menu = menuRef.current;
        menu.style.position = "fixed";
        // Below the trigger, or above it when there is no room below.
        const height = menu.offsetHeight || 0;
        const below = rect.bottom + 4;
        const top =
          below + height > window.innerHeight - 8 && rect.top - 4 - height >= 8
            ? rect.top - 4 - height
            : below;
        menu.style.top = `${Math.max(8, top)}px`;
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

  // KEYBOARD. Opening moves focus into the menu (its first item); Up/Down move
  // between items and wrap; Home/End jump; Escape (below) closes and returns
  // focus to the trigger, so a keyboard user is never stranded on <body>.
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const first = menu.querySelector('[role="menuitem"]:not(:disabled)');
    if (first && typeof first.focus === "function") first.focus();
  }, []);

  const onMenuKeyDown = (e) => {
    const menu = menuRef.current;
    if (!menu) return;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]:not(:disabled)'));
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === "ArrowDown") next = items[(index + 1 + items.length) % items.length];
    else if (e.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (e.key === "Home") next = items[0];
    else if (e.key === "End") next = items[items.length - 1];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

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

  // Escape closes — and hands focus back to the trigger.
  useEffect(() => {
    function handleEsc(e) {
      if (e.key === "Escape") {
        if (shareOpen) setShareOpen(false);
        else {
          onClose?.();
          if (anchorEl && typeof anchorEl.focus === "function") anchorEl.focus();
        }
      }
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose, shareOpen, anchorEl]);

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

  const portalTarget = typeof document !== "undefined" ? document.body : null;

  const menu = (
    <>
      <div
        ref={menuRef}
        role="menu"
        onKeyDown={onMenuKeyDown}
        style={lightLockVars}
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
              role="menuitem"
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

  return portalTarget ? createPortal(menu, portalTarget) : menu;
}
