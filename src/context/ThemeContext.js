// src/context/ThemeContext.js
import React, { createContext, useContext, useEffect, useState } from "react";

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    try {
      const stored = window.localStorage.getItem("sitewise-theme");
      if (stored === "dark" || stored === "light") return stored;
    } catch {
      // ignore
    }
    return "light"; // DEFAULT = LIGHT
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;

    // Tailwind dark mode uses the "dark" class
    root.classList.remove("dark");
    if (theme === "dark") {
      root.classList.add("dark");
    }

    try {
      window.localStorage.setItem("sitewise-theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
