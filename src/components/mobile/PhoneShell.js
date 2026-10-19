// src/components/mobile/PhoneShell.js
//
// THE PHONE SHELL (Phase 8E.1) — NoteWise's capture-first phone composition.
//
//   ┌──────────────────────────────┐  ← status bar / notch (safe area)
//   │  the visible screen          │
//   │  Projects │ Note │ Listen In │
//   │  PDFs │ More                 │
//   ├──────────────────────────────┤
//   │ ● Recording 12:04  · Open    │  ← Listen In mini-bar (unfinished meeting)
//   ├──────────────────────────────┤
//   │ Projects Note ListenIn PDFs More │  ← bottom navigation (home indicator)
//   └──────────────────────────────┘
//
// It is a COMPOSITION, not a second application. Every screen reads and writes
// the same application state, Listen In engine, stores and domain components
// the desktop shell uses; App.js chooses between the two shells once, at the
// application boundary.
//
// STATE THAT MUST SURVIVE NAVIGATION is never held by a transient screen:
//   - the open note, project and folder are the application state's;
//   - the Note screen (MainArea, and with it the Quick Add composer and its
//     unsent draft, dictation and staged attachments) STAYS MOUNTED and is only
//     hidden while another screen shows;
//   - the Listen In meeting is the engine's, outside React, and the Listen In
//     screen's visibility is the provider's own `open` boolean — so leaving the
//     screen is exactly the desktop Close: one boolean, never a stop;
//   - the Projects browse position and the remembered tab are this shell's,
//     which lives as long as the phone composition does.
//
// This shell owns NO recording and NO audio. Native background capture is
// Phase 8E.2 and will replace the engine's capture adapter beneath the same
// Listen In hook; nothing here has to change for it.
import React, { useCallback, useEffect, useRef, useState } from "react";
import "./mobileShell.css";
import MainArea from "../MainArea";
import { ListenInWindow, LISTEN_IN_PRESENTATION } from "../LiveTranscriptDialog";
import { useAppState } from "../../context/AppStateContext";
import { useLiveTranscriptSession } from "../../context/LiveTranscriptContext";
import { SHELL_LAYOUT, ShellLayoutContext } from "../../context/ShellLayoutContext";
import {
  MOBILE_TAB,
  browsePathFromSelection,
  initialMobileTab,
  isKeyboardOpen,
  isTextEntryElement,
  locateNote,
  shouldShowListenInMiniBar,
  visibleMobileTab,
} from "../../lib/mobileShell";
import MobileBottomNav from "./MobileBottomNav";
import ListenInMiniBar from "./ListenInMiniBar";
import MobileProjectsScreen from "./MobileProjectsScreen";
import MobileNoteBar from "./MobileNoteBar";
import MobilePdfScreen from "./MobilePdfScreen";
import MobileMoreScreen from "./MobileMoreScreen";

/**
 * Track the on-screen keyboard through the visual viewport. The shell's box is
 * written straight to the DOM (never React state), so a keyboard animation or
 * a visual-viewport scroll does not re-render the note workspace underneath;
 * only the open/closed boolean is state.
 */
function useVisualViewportFit(shellRef) {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const vv = window.visualViewport;
    if (!vv || typeof vv.addEventListener !== "function") return undefined;
    const apply = () => {
      const open = isKeyboardOpen({ layoutHeight: window.innerHeight, visualHeight: vv.height });
      const el = shellRef.current;
      if (el) {
        if (open) {
          el.style.height = `${Math.round(vv.height)}px`;
          el.style.top = `${Math.round(vv.offsetTop)}px`;
        } else {
          el.style.height = "";
          el.style.top = "";
        }
      }
      setKeyboardOpen((prev) => (prev === open ? prev : open));
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    };
  }, [shellRef]);
  return keyboardOpen;
}

/**
 * @param children  the App-owned dialogs the phone opens (Settings, the
 *                  Template Library / Builder). They are rendered INSIDE the
 *                  shell's root — after the navigation, as fixed overlays —
 *                  so they receive the phone shell's layout context and its
 *                  stylesheet reaches them; the desktop shell renders the
 *                  same dialogs beside its own workspace, unchanged.
 */
export default function PhoneShell({
  onOpenSettings,
  onOpenTemplateLibrary,
  banner = null,
  children = null,
}) {
  const app = useAppState() || {};
  const {
    state,
    rootNotes,
    currentNoteId = null,
    activeProjectId = null,
    activeFolderId = null,
    workspace,
    setWorkspace,
    noteWorkspaceTab,
    setNoteWorkspaceTab,
    setActiveSelection,
    clearActiveSelection,
    setCurrentNoteId,
    setCurrentPdfId,
  } = app;
  const listenIn = useLiveTranscriptSession();
  const shellRef = useRef(null);

  const [tab, setTab] = useState(() => initialMobileTab({ currentNoteId }));
  const [browse, setBrowse] = useState(() =>
    browsePathFromSelection({ activeProjectId, activeFolderId })
  );
  const listenInOpen = !!(listenIn && listenIn.open);
  const visibleTab = visibleMobileTab({ tab, listenInOpen });

  // PHONE POLICY over shared state: the note workspace shows the NOTE (the
  // desktop PDF tab and PDFs workspace are the desktop editor's), so a value
  // left behind by the desktop shell is brought back to the note view here.
  useEffect(() => {
    if (workspace === "pdfs" && typeof setWorkspace === "function") setWorkspace("projects");
  }, [workspace, setWorkspace]);
  useEffect(() => {
    if (noteWorkspaceTab && noteWorkspaceTab !== "note" && typeof setNoteWorkspaceTab === "function") {
      setNoteWorkspaceTab("note");
    }
  }, [noteWorkspaceTab, setNoteWorkspaceTab]);

  // A real SELECTION change (opening a note, creating a folder) moves the
  // drill-down there. Browsing never changes the selection, so this cannot
  // fight the user's own navigation.
  const selectionRef = useRef({ activeProjectId, activeFolderId });
  useEffect(() => {
    const prev = selectionRef.current;
    if (prev.activeProjectId === activeProjectId && prev.activeFolderId === activeFolderId) return;
    selectionRef.current = { activeProjectId, activeFolderId };
    setBrowse(browsePathFromSelection({ activeProjectId, activeFolderId }));
  }, [activeProjectId, activeFolderId]);

  // A note that becomes open — opened from Projects, or just created there —
  // is shown. A note CLOSING (deleted, or a folder selected) never moves the
  // user off the screen they are on.
  const noteRef = useRef(currentNoteId);
  useEffect(() => {
    if (noteRef.current === currentNoteId) return;
    noteRef.current = currentNoteId;
    if (currentNoteId) setTab(MOBILE_TAB.NOTE);
  }, [currentNoteId]);

  const selectTab = useCallback(
    (next) => {
      if (next === MOBILE_TAB.LISTEN_IN) {
        if (listenIn && !listenIn.open) listenIn.openWorkspace(null);
        return;
      }
      setTab(next);
      // Leaving Listen In is its Close: one boolean. The meeting is untouched.
      if (listenIn && listenIn.open) listenIn.closeWorkspace();
    },
    [listenIn]
  );

  const openListenIn = useCallback(() => {
    if (listenIn && !listenIn.open) listenIn.openWorkspace(null);
  }, [listenIn]);

  const openNote = useCallback(
    ({ projectId = null, folderId = null, noteId }) => {
      if (!noteId) return;
      // Commit the note's location as the selection first (it closes whatever
      // note was open), then open the note — the same two operations the
      // desktop tree performs, in the same order.
      if (folderId) {
        if (typeof setActiveSelection === "function") setActiveSelection(projectId, folderId);
      } else if (typeof clearActiveSelection === "function") {
        clearActiveSelection();
      }
      if (typeof setCurrentNoteId === "function") setCurrentNoteId(noteId);
      setTab(MOBILE_TAB.NOTE);
    },
    [setActiveSelection, clearActiveSelection, setCurrentNoteId]
  );

  const backToProjects = useCallback(() => {
    const location = currentNoteId
      ? locateNote({ ...(state || {}), rootNotes: rootNotes || [] }, currentNoteId)
      : null;
    setBrowse(
      location
        ? { projectId: location.projectId, folderId: location.folderId }
        : browsePathFromSelection({ activeProjectId, activeFolderId })
    );
    setTab(MOBILE_TAB.PROJECTS);
  }, [currentNoteId, state, rootNotes, activeProjectId, activeFolderId]);

  const openLinkedPdf = useCallback(
    (pdfId) => {
      if (!pdfId) return;
      if (typeof setCurrentPdfId === "function") setCurrentPdfId(pdfId);
      setTab(MOBILE_TAB.PDFS);
    },
    [setCurrentPdfId]
  );

  // TYPING: while a text field has focus and the keyboard is up, the bottom
  // navigation steps aside so the composer sits directly above the keyboard.
  // The Listen In mini-bar stays: a live recording is never hidden.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return undefined;
    const onFocusIn = (event) => setTyping(isTextEntryElement(event.target));
    const onFocusOut = () => {
      setTimeout(() => {
        setTyping(isTextEntryElement(typeof document !== "undefined" ? document.activeElement : null));
      }, 0);
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    return () => {
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  const keyboardOpen = useVisualViewportFit(shellRef);
  const navHidden = typing && keyboardOpen;

  const showMiniBar = shouldShowListenInMiniBar({ listenIn, visibleTab });

  return (
    <ShellLayoutContext.Provider value={SHELL_LAYOUT.PHONE}>
      <div
        ref={shellRef}
        className="nw-phone-shell bg-white dark:bg-gray-950 text-black dark:text-white"
        data-nw-shell="phone"
        data-nw-keyboard={navHidden ? "open" : undefined}
      >
        {banner}
        <div className="nw-phone-content">
          <section
            className="nw-phone-screen"
            hidden={visibleTab !== MOBILE_TAB.PROJECTS}
            aria-label="Projects"
            data-nw-phone-screen={MOBILE_TAB.PROJECTS}
          >
            <MobileProjectsScreen browse={browse} onBrowse={setBrowse} onOpenNote={openNote} />
          </section>

          {/* THE NOTE SCREEN — always mounted, only hidden. The composer's
              unsent draft lives inside it and must survive every tab switch. */}
          <section
            className="nw-phone-screen nw-phone-screen--note"
            hidden={visibleTab !== MOBILE_TAB.NOTE}
            aria-label="Note"
            data-nw-phone-screen={MOBILE_TAB.NOTE}
          >
            <MobileNoteBar
              onBackToProjects={backToProjects}
              onOpenLinkedPdf={openLinkedPdf}
              onOpenTemplateLibrary={onOpenTemplateLibrary}
            />
            <div className="nw-phone-note-workspace">
              <MainArea />
            </div>
          </section>

          <section
            className="nw-phone-screen"
            hidden={visibleTab !== MOBILE_TAB.LISTEN_IN}
            aria-label="Listen In"
            data-nw-phone-screen={MOBILE_TAB.LISTEN_IN}
          >
            <ListenInWindow presentation={LISTEN_IN_PRESENTATION.PHONE} />
          </section>

          <section
            className="nw-phone-screen"
            hidden={visibleTab !== MOBILE_TAB.PDFS}
            aria-label="PDFs"
            data-nw-phone-screen={MOBILE_TAB.PDFS}
          >
            <MobilePdfScreen />
          </section>

          <section
            className="nw-phone-screen"
            hidden={visibleTab !== MOBILE_TAB.MORE}
            aria-label="More"
            data-nw-phone-screen={MOBILE_TAB.MORE}
          >
            <MobileMoreScreen onOpenSettings={onOpenSettings} />
          </section>
        </div>

        {showMiniBar && <ListenInMiniBar listenIn={listenIn} onOpen={openListenIn} />}

        {!navHidden && (
          <MobileBottomNav
            activeTab={visibleTab}
            onSelect={selectTab}
            listenInRecording={!!(listenIn && listenIn.recording && !listenIn.completing)}
          />
        )}

        {/* SHELL-LEVEL DIALOGS (App-owned; see `children` above). Fixed
            overlays: they take no space in the column and cover the whole
            screen, navigation included, while open. */}
        {children}
      </div>
    </ShellLayoutContext.Provider>
  );
}
