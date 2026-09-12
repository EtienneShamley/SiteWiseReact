// src/components/ListenInExportFlow.test.js
//
// THE LISTEN IN ACTION BAR AND ITS EXPORT CHOOSER (Phase 8D.1 UI correction),
// rendered.
//
// A Listen In session is a first-class result now, so it is EXPORTED rather
// than inserted into whichever note happens to be open. This renders the real
// window over the real engine and asserts what the user can and cannot reach:
// no insertion, one Export, and a chooser offering the three content choices
// and the five locked formats. The producers are injected so the test can see
// WHICH canonical one each format reaches without running html2pdf in jsdom.
import React, { useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import LiveTranscriptDialog from "./LiveTranscriptDialog";
import ListenInExportDialog, { buildListenInExportFile } from "./ListenInExportDialog";
import { LiveTranscriptContext } from "../context/LiveTranscriptContext";
import useLiveTranscript from "../hooks/useLiveTranscript";
import {
  getListenInEngine,
  resetListenInEnginesForTests,
} from "../lib/listenIn/listenInEngine";
import { CHUNK_STATE } from "../lib/listenIn/listenInModel";
import { LISTEN_IN_EXPORT_CONTENT, LISTEN_IN_EXPORT_FORMAT } from "../lib/listenIn/listenInExport";
import { createListenInMemoryStore } from "../lib/listenIn/listenInStore";
import { resetMicrophoneOwnershipForTests } from "../lib/microphoneOwnership";

global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("../hooks/useRefine", () => ({
  useRefine: () => ({ refineText: jest.fn(async () => ({ ok: true, refined: "A tidy summary." })) }),
}));

const WS = "ws-export";
const UID = "uid-export";

let host;
let root;
let api;

const CHUNKS = [
  { seq: 0, state: CHUNK_STATE.TRANSCRIBED, text: "First thing said." },
  { seq: 1, state: CHUNK_STATE.TRANSCRIBED, text: "Second thing said." },
];

/** A session snapshot the window can render without recording anything. */
function stubSession(overrides = {}) {
  return {
    engine: {},
    session: { title: "Listen In — test", startedAt: 1, stoppedAt: 2, language: "en", state: "finished" },
    chunks: CHUNKS,
    error: null,
    pending: 0,
    failed: 0,
    survivesReload: true,
    supported: true,
    recording: false,
    interrupted: false,
    finishing: false,
    transcript: "First thing said. Second thing said.",
    start: jest.fn(),
    stop: jest.fn(),
    resume: jest.fn(),
    finish: jest.fn(),
    discard: jest.fn(),
    retryFailed: jest.fn(),
    clearError: jest.fn(),
    ...overrides,
  };
}

function Window({ value }) {
  return (
    <LiveTranscriptContext.Provider
      value={{
        ...value,
        language: "auto",
        chooseLanguage: () => {},
        open: true,
        openWorkspace: () => {},
        closeWorkspace: () => {},
        insertTarget: { canInsert: true, noteTitle: "Some note", reason: "" },
        registerInsertTarget: () => {},
        insertTranscript: () => true,
      }}
    >
      <LiveTranscriptDialog />
    </LiveTranscriptContext.Provider>
  );
}

function mountWindow(value = stubSession()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Window value={value} />));
}

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
  resetListenInEnginesForTests();
  resetMicrophoneOwnershipForTests();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

const buttons = () => [...document.querySelectorAll("button")];
const byText = (re) => buttons().find((b) => re.test(b.textContent));
const click = (el) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const chooser = () => document.querySelector('[data-listen-in-export="dialog"]');

/* ====================== 1/2/3/4. the action bar ========================== */

describe("1/2. Listen In no longer offers to insert into a note", () => {
  test("neither Insert action is rendered, even with a note registered and ready", async () => {
    mountWindow();
    await flush();
    expect(byText(/Insert into note/)).toBeUndefined();
    expect(byText(/Insert summary/)).toBeUndefined();
    expect(document.body.textContent).not.toMatch(/Insert/);
  });

  test("the summary card offers no insertion either", async () => {
    mountWindow();
    await flush();
    click(byText(/^Summarise$/));
    await flush();
    expect(document.body.textContent).toMatch(/A tidy summary\./);
    expect(byText(/Insert summary/)).toBeUndefined();
  });
});

describe("3/4. one Export action, and the per-format buttons are gone", () => {
  test("exactly one Export button, and no .txt/.md buttons", async () => {
    mountWindow();
    await flush();
    expect(buttons().filter((b) => /^Export$/.test(b.textContent.trim()))).toHaveLength(1);
    expect(byText(/Export \.txt/)).toBeUndefined();
    expect(byText(/Export \.md/)).toBeUndefined();
  });

  test("11/12. Copy and Discard remain", async () => {
    mountWindow();
    await flush();
    expect(byText(/^Copy$/)).toBeDefined();
    expect(byText(/^Discard$/)).toBeDefined();
  });

  test("Export is disabled when the session holds nothing to export", async () => {
    mountWindow(stubSession({ chunks: [], transcript: "" }));
    await flush();
    expect(byText(/^Export$/).disabled).toBe(true);
  });

  test("pressing Export opens the chooser rather than downloading anything", async () => {
    mountWindow();
    await flush();
    expect(chooser()).toBeNull();
    click(byText(/^Export$/));
    await flush();
    expect(chooser()).not.toBeNull();
    expect(chooser().getAttribute("aria-modal")).toBe("true");
  });
});

/* ========================= 5/6. what the chooser offers ================== */

describe("5/6. the chooser offers three content choices and five formats", () => {
  function mountChooser(props = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <ListenInExportDialog
          open
          onClose={() => {}}
          session={{ title: "Listen In — test" }}
          chunks={CHUNKS}
          summary={{ text: "A tidy summary." }}
          hasSummary
          hasTranscript
          {...props}
        />
      )
    );
  }

  const labelsIn = (groupLabel) =>
    [...document.querySelectorAll(`[role="radiogroup"][aria-label="${groupLabel}"] [role="radio"]`)].map(
      (el) => el.querySelector("span span").textContent.trim()
    );

  test("content: Summary, Transcript, Summary + Transcript", () => {
    mountChooser();
    expect(labelsIn("What to export")).toEqual(["Summary", "Transcript", "Summary + Transcript"]);
  });

  test("format: PDF, Word, Markdown, Plain Text, HTML — and nothing else", () => {
    mountChooser();
    expect(labelsIn("Format")).toEqual([
      "PDF .pdf",
      "Word .docx",
      "Markdown .md",
      "Plain Text .txt",
      "HTML .html",
    ]);
    expect(document.body.textContent).not.toMatch(/CSV|XLSX|JSON|RTF/i);
  });

  test("a content choice the session cannot satisfy is not offered", () => {
    mountChooser({ hasSummary: false });
    expect(labelsIn("What to export")).toEqual(["Transcript", "Summary + Transcript"]);
  });
});

/* ================= 7/8/9/10. what each choice actually builds ============ */

describe("7/8/9/10. the build reaches the canonical producers with the right document", () => {
  const producers = () => ({
    buildPdf: jest.fn(async ({ html, noteTitle }) => ({ name: `${noteTitle}.pdf`, html, blob: new Blob(["pdf"]) })),
    buildDocx: jest.fn(async ({ html, title }) => ({ name: `${title}.docx`, html, blob: new Blob(["docx"]) })),
    buildMarkdown: jest.fn(async ({ html, title }) => ({ name: `${title}.md`, html, blob: new Blob(["md"]) })),
    buildHtml: jest.fn(async ({ html, title }) => ({ name: `${title}.html`, html, blob: new Blob(["html"]) })),
  });

  const session = { title: "Listen In — test" };
  const summary = { text: "A tidy summary." };

  test("10. each format reaches its OWN canonical producer, and only that one", async () => {
    for (const [format, key] of [
      [LISTEN_IN_EXPORT_FORMAT.PDF, "buildPdf"],
      [LISTEN_IN_EXPORT_FORMAT.DOCX, "buildDocx"],
      [LISTEN_IN_EXPORT_FORMAT.MARKDOWN, "buildMarkdown"],
      [LISTEN_IN_EXPORT_FORMAT.HTML, "buildHtml"],
    ]) {
      const deps = producers();
      await buildListenInExportFile(
        { session, chunks: CHUNKS, summary, content: LISTEN_IN_EXPORT_CONTENT.BOTH, format },
        deps
      );
      expect(deps[key]).toHaveBeenCalledTimes(1);
      for (const other of Object.keys(deps)) {
        if (other !== key) expect(deps[other]).not.toHaveBeenCalled();
      }
    }
  });

  test("plain text is the one adapter — it reaches no producer at all", async () => {
    const deps = producers();
    const file = await buildListenInExportFile(
      { session, chunks: CHUNKS, summary, content: LISTEN_IN_EXPORT_CONTENT.BOTH, format: LISTEN_IN_EXPORT_FORMAT.TEXT },
      deps
    );
    for (const key of Object.keys(deps)) expect(deps[key]).not.toHaveBeenCalled();
    expect(file.name).toMatch(/\.txt$/);
    expect(file.text).toContain("A tidy summary.");
    expect(file.text).toContain("First thing said.");
    expect(file.text).not.toMatch(/<[a-z]/i);
  });

  test("7. Summary carries the summary and NOT the transcript", async () => {
    const deps = producers();
    await buildListenInExportFile(
      { session, chunks: CHUNKS, summary, content: LISTEN_IN_EXPORT_CONTENT.SUMMARY, format: LISTEN_IN_EXPORT_FORMAT.PDF },
      deps
    );
    const { html } = deps.buildPdf.mock.calls[0][0];
    expect(html).toContain("A tidy summary.");
    expect(html).not.toContain("First thing said.");
  });

  test("8. Transcript carries the full ordered transcript and no summary", async () => {
    const deps = producers();
    await buildListenInExportFile(
      { session, chunks: CHUNKS, summary, content: LISTEN_IN_EXPORT_CONTENT.TRANSCRIPT, format: LISTEN_IN_EXPORT_FORMAT.DOCX },
      deps
    );
    const { html } = deps.buildDocx.mock.calls[0][0];
    expect(html).not.toContain("A tidy summary.");
    expect(html.indexOf("First thing said.")).toBeLessThan(html.indexOf("Second thing said."));
  });

  test("9. Summary + Transcript carries both, summary first", async () => {
    const deps = producers();
    await buildListenInExportFile(
      { session, chunks: CHUNKS, summary, content: LISTEN_IN_EXPORT_CONTENT.BOTH, format: LISTEN_IN_EXPORT_FORMAT.HTML },
      deps
    );
    const { html } = deps.buildHtml.mock.calls[0][0];
    expect(html.indexOf("A tidy summary.")).toBeLessThan(html.indexOf("First thing said."));
  });

  test("choosing and pressing Export downloads through the shared helper, then closes", async () => {
    const deps = producers();
    const download = jest.fn();
    const onClose = jest.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        <ListenInExportDialog
          open
          onClose={onClose}
          session={session}
          chunks={CHUNKS}
          summary={summary}
          hasSummary
          hasTranscript
          deps={{ ...deps, download }}
        />
      )
    );
    click([...document.querySelectorAll('[role="radio"]')].find((e) => /Transcript$/.test(e.textContent.split(" ")[0] + "")) || byText(/^Transcript/));
    click(byText(/^Export$/));
    await flush();
    expect(download).toHaveBeenCalledTimes(1);
    const [name, blob] = download.mock.calls[0];
    expect(name).toMatch(/\.pdf$/);
    expect(blob).toBeInstanceOf(Blob);
    expect(onClose).toHaveBeenCalled();
  });
});

/* ============================ 13. the session ============================ */

describe("13. recording behaviour is untouched by any of this", () => {
  test("the engine still starts, records and stops through the window", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: jest.fn(async () => ({ getTracks: () => [{ stop: jest.fn() }] })) },
      configurable: true,
    });
    class Rec {
      static isTypeSupported = () => true;
      constructor() {
        this.state = "inactive";
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        if (this.onstop) this.onstop();
      }
    }
    const realRec = global.MediaRecorder;
    global.MediaRecorder = Rec;
    try {
      getListenInEngine(UID, WS, {
        store: createListenInMemoryStore(),
        transcribe: async () => "words",
        recorderSupported: () => true,
      });
      let live = null;
      function Probe() {
        live = useLiveTranscript({ uid: UID, workspaceId: WS });
        return null;
      }
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      act(() => root.render(<Probe />));
      await flush();
      await act(async () => {
        await live.start({ language: "en" });
      });
      await flush();
      expect(live.recording).toBe(true);
      await act(async () => {
        await live.stop();
      });
      await flush();
      expect(live.recording).toBe(false);
    } finally {
      global.MediaRecorder = realRec;
    }
  });
});
