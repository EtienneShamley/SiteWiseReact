import React from "react";
import { useTheme } from "../ThemeContext";

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="bg-gray-800 text-white px-3 py-1 rounded hover:bg-gray-600 text-lg shadow absolute top-4 right-4"
      title="Toggle dark/light mode"
      style={{ zIndex: 50 }}
    >
      {theme === "dark" ? "🌙" : "☀️"}
    </button>
  );
}
