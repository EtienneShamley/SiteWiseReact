import React, { useState } from "react";
import Sidebar from "./components/Sidebar";
import MiddlePane from "./components/MiddlePane";
import MainArea from "./components/MainArea";
import { ThemeProvider } from "./context/ThemeContext";
import { Cog6ToothIcon } from "@heroicons/react/24/outline";
import SettingsModal from "./components/SettingsModal";

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <ThemeProvider>
      <div className="flex min-h-screen bg-white dark:bg-[#1a1a1a] text-black dark:text-white relative">
        <Sidebar />
        <MiddlePane />
        <MainArea />

        {/* Settings Button in Left Bottom Corner (theme-aware) */}
        <button
          onClick={() => setSettingsOpen(true)}
          className="fixed bottom-4 left-4 rounded-full p-3 shadow-lg z-50
                     bg-white text-black border border-gray-300 hover:bg-gray-100
                     dark:bg-[#222] dark:text-white dark:border-gray-700 dark:hover:bg-[#2b2b2b]"
          title="Settings"
        >
          <Cog6ToothIcon className="w-7 h-7" />
        </button>
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </div>
    </ThemeProvider>
  );
}

export default App;
