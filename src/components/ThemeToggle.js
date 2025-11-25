import React from "react";
import { useTheme } from "../context/ThemeContext";

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="
        px-3 py-1 rounded shadow absolute top-4 right-4 text-sm
        bg-white text-black hover:bg-gray-200
        dark:bg-[#333] dark:text-white dark:hover:bg-[#444]
      "
      style={{ zIndex: 50 }}
      title="Toggle dark/light mode"
    >
      {theme === "dark" ? "Dark" : "Light"}
    </button>
  );
}
