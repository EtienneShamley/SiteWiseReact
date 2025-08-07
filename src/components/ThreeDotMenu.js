import React, { useEffect, useRef } from "react";
import { FaPen, FaTrash, FaShare, FaArchive } from "react-icons/fa";

export default function ThreeDotMenu({
  anchorRef,
  onClose,
  options = [],
  theme = "light",
}) {
  const menuRef = useRef();

  // Positioning logic: position below anchor
  useEffect(() => {
    function positionMenu() {
      if (anchorRef && menuRef.current) {
        const rect = anchorRef.getBoundingClientRect();
        menuRef.current.style.position = "fixed";
        menuRef.current.style.top = `${rect.bottom + 4}px`;
        menuRef.current.style.left = `${rect.left}px`;
        menuRef.current.style.zIndex = 9999;
      }
    }
    positionMenu();
    window.addEventListener("resize", positionMenu);
    return () => window.removeEventListener("resize", positionMenu);
  }, [anchorRef]);

  // Close on outside click
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

  // Escape key closes
  useEffect(() => {
    function handleEsc(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className={`
        min-w-[170px] py-1 shadow-lg rounded-xl border 
        border-gray-200 dark:border-gray-700 
        bg-white dark:bg-[#232323]
        absolute
      `}
    >
      {options.map((opt, idx) => (
        <button
          key={opt.label}
          className={`
            flex items-center gap-2 px-4 py-2 w-full text-left text-sm
            hover:bg-gray-100 dark:hover:bg-[#333]
            transition-colors
            ${opt.danger ? "text-red-600" : "text-gray-900 dark:text-gray-100"}
            rounded-none
            ${idx === options.length - 1 ? "rounded-b-xl" : ""}
          `}
          onClick={opt.onClick}
        >
          <span>{opt.icon}</span>
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}
