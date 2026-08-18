import React, { useCallback, useEffect, useState } from "react";
import Sidebar from "./components/Sidebar";
import MiddlePane from "./components/MiddlePane";
import MainArea from "./components/MainArea";
import { ThemeProvider } from "./context/ThemeContext";
import SettingsModal from "./components/SettingsModal";
import TemplateBuilderModal from "./components/template/TemplateBuilderModal";
import useMediaQuery from "./hooks/useMediaQuery";
import { LiveTranscriptProvider } from "./context/LiveTranscriptContext";
import LiveTranscriptDialog from "./components/LiveTranscriptDialog";
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

// The left sidebar compacts to its icon rail below this width; expanding it
// there opens it as an overlay drawer instead of pushing the document aside.
export const SIDEBAR_COMPACT_QUERY = "(max-width: 1023px)";

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The reusable-template workspace (Template Library) is a workspace-level
  // dialog opened from the sidebar; its open state lives here, beside the
  // sidebar that opens it and the modal that renders it.
  const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false);

  // The Middle Pane's collapsed/restored state is owned here rather than
  // inside MiddlePane itself, because restoring it is now triggered from the
  // Sidebar header — Sidebar and MiddlePane are siblings with no shared
  // context for this, and it is purely transient UI state (never persisted).
  const [middlePaneHidden, setMiddlePaneHidden] = useState(false);

  // Left sidebar width: the user's choice (expanded / icon rail), transient and
  // never persisted. On a narrow viewport the sidebar rests as its rail and
  // "expand" opens it as an overlay drawer over the workspace, so a narrow
  // window never loses document width to sidebar labels and never scrolls
  // horizontally to keep them. `sidebarCollapsed` is the wide-viewport choice;
  // `sidebarDrawerOpen` is the narrow-viewport drawer; the effective state is
  // derived from whichever applies. Neither touches any editor or note state.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const compact = useMediaQuery(SIDEBAR_COMPACT_QUERY);
  const sidebarIsRail = compact ? !sidebarDrawerOpen : sidebarCollapsed;
  const sidebarOverlay = compact && sidebarDrawerOpen;
  const toggleSidebar = useCallback(() => {
    if (compact) setSidebarDrawerOpen((open) => !open);
    else setSidebarCollapsed((collapsed) => !collapsed);
  }, [compact]);
  const closeSidebarDrawer = useCallback(() => setSidebarDrawerOpen(false), []);
  // Leaving the narrow range closes the drawer, so a window widened while it
  // was open returns to the ordinary in-flow sidebar.
  useEffect(() => {
    if (!compact) setSidebarDrawerOpen(false);
  }, [compact]);

  useEffect(() => {
    runTemplateMigration();
  }, []);

  return (
    <ThemeProvider>
    {/* ONE Live Transcript session for the whole shell — the sidebar opens it,
        MainArea renders its workspace and inserts from it, and it survives
        every layout change (see src/context/LiveTranscriptContext.js). */}
    <LiveTranscriptProvider>
      {/* The application shell is exactly one viewport tall (h-screen; 100dvh
          where the browser supports it, so mobile browser chrome cannot hide
          the bottom of the workspace). Each column then owns its own vertical
          scrolling — the two panes scroll their lists, and MainArea's document
          workspace scrolls the document — instead of the whole page growing to
          the document's height and carrying the toolbar out of reach.
          Deliberately NOT overflow-hidden: on a viewport too short even for the
          fixed chrome the page still scrolls rather than clipping content.
          `overflow-x-hidden` only stops a transient horizontal scrollbar while
          the sidebar animates between widths — nothing in the shell is wider
          than the viewport. */}
      <div className="flex h-screen supports-[height:100dvh]:h-dvh overflow-x-hidden bg-white dark:bg-gray-950 text-black dark:text-white relative">
        <PersistenceErrorBanner />
        {/* While the narrow-viewport drawer overlays the workspace, the rail's
            width stays reserved in the row so the document does not shift
            underneath the drawer. */}
        {sidebarOverlay && <div className="w-14 shrink-0" aria-hidden="true" />}
        <Sidebar
          middlePaneHidden={middlePaneHidden}
          onShowMiddlePane={() => setMiddlePaneHidden(false)}
          collapsed={sidebarIsRail}
          overlay={sidebarOverlay}
          onToggleCollapsed={toggleSidebar}
          onCloseOverlay={closeSidebarDrawer}
          templateLibraryOpen={templateLibraryOpen}
          onOpenTemplateLibrary={() => setTemplateLibraryOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <MiddlePane
          middlePaneHidden={middlePaneHidden}
          onHideMiddlePane={() => setMiddlePaneHidden(true)}
        />
        <MainArea />

        {/* Settings is opened from the sidebar footer (its Settings control);
            the modal itself is rendered here at the shell level. */}
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        {/* The top-level reusable-template workspace — where company templates
            are CREATED and MANAGED, separate from any one note. Opened from
            the sidebar's Workspace group. */}
        <TemplateBuilderModal
          open={templateLibraryOpen}
          onClose={() => setTemplateLibraryOpen(false)}
        />
        {/* The Live Transcript workspace is SHELL-level, like the dialogs
            above: it must open, record, stop and stay readable in every
            workspace — with a note, with none, and in the PDFs workspace,
            which MainArea's note branch never renders. Where a transcript
            would go is registered with the session by MainArea. */}
        <LiveTranscriptDialog />
      </div>
    </LiveTranscriptProvider>
    </ThemeProvider>
  );
}

export default App;
