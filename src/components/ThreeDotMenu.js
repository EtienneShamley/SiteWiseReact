import React, { useEffect, useRef } from "react";

export default function ThreeDotMenu({
  anchorRef,
  onClose,
  options = [],
  theme = "light",
}) {
  const menuRef = useRef();

  // Position below anchor
  useEffect(() => {
    function positionMenu() {
      if (anchorRef && menuRef.current) {
        const rect = anchorRef.getBoundingClientRect();
        const menu = menuRef.current;
        menu.style.position = "fixed";
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${rect.left}px`;
        menu.style.zIndex = 9999;
      }
    }
    positionMenu();
    window.addEventListener("resize", positionMenu);
    return () => window.removeEventListener("resize", positionMenu);
  }, [anchorRef]);

  // Outside click
  useEffect(() => {
    function handleClick(e) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target) &&
        anchorRef &&
        !anchorRef.contains(e.target)
      ) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, anchorRef]);

  // Escape closes
  useEffect(() => {
    function handleEsc(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  // THEME (no default bg-white anywhere; only theme-driven)
  const isDark = theme === "dark";
  const menuBg = isDark ? "bg-[#232323]" : "bg-white";
  const menuText = isDark ? "text-white" : "text-gray-900";
  const menuBorder = isDark ? "border-[#333]" : "border-gray-200";
  const itemHover = isDark ? "hover:bg-[#333]" : "hover:bg-gray-100";
  const iconColor = isDark ? "text-white" : "text-gray-700";

  return (
    <div
      ref={menuRef}
      className={`min-w-[170px] py-1 shadow-lg rounded-xl border ${menuBorder} ${menuBg} ${menuText} absolute`}
    >
      {options.map((opt, idx) => (
        <button
          key={opt.label}
          className={`flex items-center gap-2 px-4 py-2 w-full text-left text-sm ${itemHover} transition-colors ${
            opt.danger ? "text-red-500" : menuText
          } ${idx === options.length - 1 ? "rounded-b-xl" : ""}`}
          onClick={opt.onClick}
        >
          {/* Make sure icons inherit the right color in dark mode */}
          <span className={`${opt.danger ? "text-red-500" : iconColor}`}>
            {opt.icon}
          </span>
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}
