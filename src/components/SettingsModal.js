import React from "react";
import { useTheme } from "../context/ThemeContext";

export default function SettingsModal({ open, onClose }) {
  const { theme, toggleTheme } = useTheme();

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-30">
      <div className="bg-white dark:bg-[#222] rounded-lg shadow-lg w-80 p-6">
        <h2 className="text-lg font-semibold mb-4 text-center">Settings</h2>
        <div className="flex items-center justify-between mb-4">
          <span className="text-gray-800 dark:text-gray-200">Theme</span>
          <button
            className={`relative w-16 h-8 bg-gray-300 dark:bg-gray-600 rounded-full transition-colors`}
            onClick={toggleTheme}
          >
            <span
              className={`absolute left-1 top-1 w-6 h-6 rounded-full bg-white dark:bg-gray-900 shadow transition-transform ${theme === "dark" ? "translate-x-8" : ""}`}
              style={{
                transition: "transform 0.2s cubic-bezier(0.4,0,0.2,1)",
              }}
            />
            <span className="sr-only">Toggle Theme</span>
          </button>
        </div>
        <button
          onClick={onClose}
          className="w-full mt-4 py-2 rounded bg-gray-800 text-white hover:bg-gray-700"
        >
          Close
        </button>
      </div>
    </div>
  );
}
