import React, { useEffect, useState } from "react";
import Sidebar from "./components/Sidebar";
import MiddlePane from "./components/MiddlePane";
import MainArea from "./components/MainArea";
import { ThemeProvider } from "./context/ThemeContext";
import { Cog6ToothIcon } from "@heroicons/react/24/outline";
import SettingsModal from "./components/SettingsModal";
import { runTemplateMigration } from "./lib/templateMigration";
import { useAppState } from "./context/AppStateContext";

// Surfaces localStorage persistence failures (tree, PDF registry, note links)
// rather than letting them fail silently.
function PersistenceErrorBanner() {
  const { persistenceError, clearPersistenceError } = useAppState();
  if (!persistenceError) return null;
  return (
    <div className="fixed top-0 inset-x-0 z-[60] flex items-center justify-between gap-3 px-4 py-2 text-sm bg-red-600 text-white shadow">
      <span className="truncate">{persistenceError}</span>
      <button className="shrink-0 underline text-xs" onClick={clearPersistenceError}>
        Dismiss
      </button>
    </div>
  );
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    runTemplateMigration();
  }, []);

  return (
    <ThemeProvider>
      <div className="flex min-h-screen bg-white dark:bg-gray-950 text-black dark:text-white relative">
        <PersistenceErrorBanner />
        <Sidebar />
        <MiddlePane />
        <MainArea />

        {/* Settings Button in Left Bottom Corner (theme-aware) */}
        <button
          onClick={() => setSettingsOpen(true)}
          className="fixed bottom-4 left-4 rounded-full p-3 shadow-lg z-50
                     bg-white text-black border border-gray-300 hover:bg-gray-100
                     dark:bg-gray-900 dark:text-white dark:border-gray-700 dark:hover:bg-gray-800"
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
