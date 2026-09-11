// src/components/BottomBarDictation.test.js
//
// QUICK ADD DICTATION, RENDERED with react-dom in jsdom (Phase 8C.1).
//
// The composer's microphone records ONE short clip, transcribes it through
// the existing transport, and puts the text into the editable Quick Add
// draft — nothing reaches the note until Send. jsdom has no microphone and no
// MediaRecorder, so both are replaced with fakes the test controls; the
// transport hook is mocked so the clip handed to it, and the text it returns,
// are observable. The Live transcript hook is mounted beside it for the
// microphone-ownership cases: the two never record at once.
import React, { useImperativeHandle, forwardRef } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import BottomBar from "./BottomBar";
import useLiveTranscript from "../hooks/useLiveTranscript";
import { AppStateContext } from "../context/AppStateContext";
import { QUICK_ADD_KIND } from "../lib/quickAddTarget";
import { DICTATION_MESSAGE } from "../lib/quickAddDictation";
import {
  TRANSCRIPTION_LANGUAGES,
  TRANSCRIPTION_LANGUAGE_MEMORY_KEY,
  loadTranscriptionLanguage,
  saveTranscriptionLanguage,
} from "../lib/transcriptionLanguage";
import { LIVE_TRANSCRIPT_MESSAGE } from "../lib/liveTranscript";
import {
  MICROPHONE_OWNER,
  claimMicrophone,
  currentMicrophoneOwner,
  releaseMicrophone,
  resetMicrophoneOwnershipForTests,
} from "../lib/microphoneOwnership";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockTranscribeBlob = jest.fn();
jest.mock("../hooks/useTranscription", () => ({
  useTranscription: () => ({ transcribeBlob: (...args) => mockTranscribeBlob(...args) }),
}));

const mockRefineText = jest.fn();
jest.mock("../hooks/useRefine", () => ({
  useRefine: () => ({ refineText: (...args) => mockRefineText(...args) }),
}));

/* ------------------------------- fakes ---------------------------------- */

class FakeMediaRecorder {
  static instances = [];
  static clipBytes = 8;
  static isTypeSupported(type) {
    return type === "audio/webm;codecs=opus";
  }
  constructor(stream, options) {
    this.stream = stream;
    this.mimeType = (options && options.mimeType) || "";
    this.state = "inactive";
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    const data = new Blob([new Uint8Array(FakeMediaRecorder.clipBytes)], { type: this.mimeType });
    if (this.ondataavailable) this.ondataavailable({ data });
    if (this.onstop) this.onstop();
  }
}

let tracks;
let getUserMedia;
function fakeStream() {
  tracks = [{ stop: jest.fn() }, { stop: jest.fn() }];
  return { getTracks: () => tracks };
}

const realMediaRecorder = globalThis.MediaRecorder;
const realMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

beforeAll(() => {
  globalThis.MediaRecorder = FakeMediaRecorder;
});
afterAll(() => {
  globalThis.MediaRecorder = realMediaRecorder;
  if (realMediaDevices) Object.defineProperty(navigator, "mediaDevices", realMediaDevices);
  else delete navigator.mediaDevices;
});

beforeEach(() => {
  localStorage.clear();
  noteId = "note-1";
  resetMicrophoneOwnershipForTests();
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.clipBytes = 8;
  getUserMedia = jest.fn(async () => fakeStream());
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: (...args) => getUserMedia(...args) },
    configurable: true,
  });
  mockTranscribeBlob.mockImplementation(async () => "Hello site");
  mockRefineText.mockImplementation(async ({ text }) => ({ ok: true, refined: `Refined: ${text}` }));
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

/* ------------------------------ harness --------------------------------- */

const freeform = { kind: QUICK_ADD_KIND.FREEFORM };
const templateRow = {
  kind: QUICK_ADD_KIND.TEMPLATE_ROW,
  rowId: "row-1",
  label: "Observations",
  fieldType: "text",
  isCustom: false,
  atCursor: false,
};
const capture = { image: true, file: true, reason: null };

let host;
let root;
let onInsertText;
let onSendComposer;

let noteId = "note-1";

function render(props) {
  act(() =>
    root.render(
      <AppStateContext.Provider value={{ currentNoteId: noteId }}>
        <BottomBar
          editor={{}}
          target={freeform}
          capture={capture}
          targetToken="note-1|freeform"
          onInsertText={onInsertText}
          onSendComposer={onSendComposer}
          {...props}
        />
      </AppStateContext.Provider>
    )
  );
}

function mount(props = {}) {
  onInsertText = jest.fn(() => true);
  onSendComposer = jest.fn(async () => ({ ok: true, deliveredIds: [], textDelivered: true }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  render(props);
}

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

const micButton = () => host.querySelector("button[data-voice-phase]");
const discardButton = () => host.querySelector('button[aria-label="Discard dictation"]');
const textarea = () => host.querySelector("textarea");
const alertLine = () => host.querySelector('[role="alert"]');
const refineButton = () => host.querySelector('button[title="Refine with AI"]');
const sendButton = () => host.querySelector('button[aria-label^="Send Quick Add"]');
const pickerInput = () => host.querySelector('input[type="file"]:not([capture])');
const languageSelect = () => host.querySelector('select[aria-label="Dictation language"]');
const languageFace = () => host.querySelector(".nw-voice-lang-compact-code");

function chooseLanguage(value) {
  const select = languageSelect();
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function storedKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i));
  return keys.sort();
}

const click = (el) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

function typeInto(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(input, files) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function dictate() {
  click(micButton());
  await flush();
  click(micButton());
  await flush();
}

/* ------------------------------- tests ---------------------------------- */

describe("1. the composer's microphone is Dictate, not a Live transcript shortcut", () => {
  test("it carries the dictation name, no dialog affordance, and opens no dialog when pressed", async () => {
    mount();
    const mic = micButton();
    expect(mic.getAttribute("aria-label")).toBe("Dictate into Quick Add");
    expect(mic.getAttribute("data-voice-phase")).toBe("idle");
    expect(host.querySelector('[aria-haspopup="dialog"]')).toBeNull();
    expect(host.querySelector('[aria-label^="Open Live transcript"]')).toBeNull();
    click(mic);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toMatch(/Live transcript/);
  });
});

describe("2/3. recording, then the clip reaches the existing transport", () => {
  test("2. the first press asks for the microphone and enters the recording state", async () => {
    mount();
    click(micButton());
    await flush();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0].state).toBe("recording");
    expect(FakeMediaRecorder.instances[0].mimeType).toBe("audio/webm;codecs=opus");
    const mic = micButton();
    expect(mic.getAttribute("data-voice-phase")).toBe("recording");
    expect(mic.getAttribute("aria-label")).toBe("Stop dictation");
    expect(mic.className).toMatch(/nw-icon-btn--danger/);
    expect(discardButton()).not.toBeNull();
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
    expect(mockTranscribeBlob).not.toHaveBeenCalled();
  });

  test("3. Stop closes the recorder into one Blob and posts it through transcribeBlob with the note's language", async () => {
    mount();
    await dictate();
    expect(FakeMediaRecorder.instances[0].state).toBe("inactive");
    expect(mockTranscribeBlob).toHaveBeenCalledTimes(1);
    const [blob, language] = mockTranscribeBlob.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(8);
    expect(blob.type).toBe("audio/webm;codecs=opus");
    expect(language).toBe("auto");
    // The microphone is released the moment the clip is closed.
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    expect(currentMicrophoneOwner()).toBeNull();
  });

  test("the transcribing phase holds Refine and Send, says so in the field, and the draft stays editable", async () => {
    mount();
    let resolveText;
    mockTranscribeBlob.mockImplementation(() => new Promise((resolve) => (resolveText = resolve)));
    click(micButton());
    await flush();
    click(micButton());
    await flush();
    expect(micButton().getAttribute("data-voice-phase")).toBe("transcribing");
    expect(micButton().getAttribute("aria-label")).toBe("Transcribing dictation");
    expect(micButton().disabled).toBe(true);
    expect(micButton().getAttribute("aria-busy")).toBe("true");
    expect(textarea().getAttribute("placeholder")).toBe("Transcribing…");
    expect(refineButton().disabled).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(textarea().disabled).toBe(false);
    typeInto(textarea(), "typed meanwhile");
    await act(async () => resolveText("dictated after"));
    await flush();
    expect(textarea().value).toBe("typed meanwhile dictated after");
    expect(micButton().getAttribute("data-voice-phase")).toBe("idle");
    expect(textarea().getAttribute("placeholder")).not.toBe("Transcribing…");
  });
});

describe("4/5/6. the text lands in the DRAFT and nowhere else", () => {
  test("4. a successful transcription appears in the Quick Add textarea", async () => {
    mount();
    await dictate();
    expect(textarea().value).toBe("Hello site");
    expect(micButton().getAttribute("data-voice-phase")).toBe("idle");
    expect(alertLine()).toBeNull();
  });

  test("5. nothing enters the note before Send; Send is the only path in", async () => {
    mount();
    await dictate();
    expect(onInsertText).not.toHaveBeenCalled();
    expect(onSendComposer).not.toHaveBeenCalled();
    click(sendButton());
    await flush();
    expect(onInsertText).toHaveBeenCalledWith("Hello site");
    expect(textarea().value).toBe("");
  });

  test("6. an existing typed draft is kept and the dictation joins it", async () => {
    mount();
    typeInto(textarea(), "Existing note");
    await dictate();
    expect(textarea().value).toBe("Existing note Hello site");
    // And it remains ordinary editable text.
    typeInto(textarea(), "Existing note Hello site, edited");
    expect(textarea().value).toBe("Existing note Hello site, edited");
  });
});

describe("7. staged attachments are untouched by a dictation", () => {
  test("a staged file stays staged before, during and after the clip", async () => {
    mount();
    choose(pickerInput(), [new File([new Uint8Array(16)], "notes.txt", { type: "text/plain" })]);
    expect(host.querySelectorAll(".nw-quickadd-staged-item")).toHaveLength(1);
    click(micButton());
    await flush();
    expect(host.querySelectorAll(".nw-quickadd-staged-item")).toHaveLength(1);
    click(micButton());
    await flush();
    expect(host.querySelectorAll(".nw-quickadd-staged-item")).toHaveLength(1);
    expect(host.textContent).toMatch(/notes\.txt/);
    expect(textarea().value).toBe("Hello site");
    expect(onSendComposer).not.toHaveBeenCalled();
  });
});

describe("8. AI actions treat the dictated draft exactly like typed text", () => {
  test("Refine runs on the dictated text and its result replaces the draft, with Revert available", async () => {
    mount();
    await dictate();
    expect(refineButton().disabled).toBe(false);
    click(refineButton());
    await flush();
    expect(mockRefineText).toHaveBeenCalledTimes(1);
    expect(mockRefineText.mock.calls[0][0].text).toBe("Hello site");
    expect(textarea().value).toBe("Refined: Hello site");
    expect(host.querySelector('button[title="Revert"]')).not.toBeNull();
    expect(onInsertText).not.toHaveBeenCalled();
  });

  test("a dictation while a refined draft is showing joins the refined text", async () => {
    mount();
    typeInto(textarea(), "rough words");
    click(refineButton());
    await flush();
    expect(textarea().value).toBe("Refined: rough words");
    await dictate();
    expect(textarea().value).toBe("Refined: rough words Hello site");
  });
});

describe("9. a destination that moved while transcribing never receives the text", () => {
  test("the result is discarded with a message; the draft and the note are untouched", async () => {
    mount();
    let resolveText;
    mockTranscribeBlob.mockImplementation(() => new Promise((resolve) => (resolveText = resolve)));
    typeInto(textarea(), "kept");
    click(micButton());
    await flush();
    click(micButton());
    await flush();
    // The user selects another Template row / note while the clip is in flight.
    render({ targetToken: "note-1|row-2", target: templateRow });
    await act(async () => resolveText("late words"));
    await flush();
    expect(textarea().value).toBe("kept");
    expect(alertLine().textContent).toBe(DICTATION_MESSAGE.DESTINATION_CHANGED);
    expect(onInsertText).not.toHaveBeenCalled();
    expect(onSendComposer).not.toHaveBeenCalled();
    expect(micButton().getAttribute("data-voice-phase")).toBe("idle");
  });

  test("a destination that did not move is accepted (same token, re-rendered)", async () => {
    mount();
    let resolveText;
    mockTranscribeBlob.mockImplementation(() => new Promise((resolve) => (resolveText = resolve)));
    click(micButton());
    await flush();
    click(micButton());
    await flush();
    render({});
    await act(async () => resolveText("on time"));
    await flush();
    expect(textarea().value).toBe("on time");
    expect(alertLine()).toBeNull();
  });
});

describe("10/11. discarding and unmounting release the microphone and insert nothing", () => {
  test("10. Discard while recording stops the tracks, transcribes nothing, leaves the draft alone", async () => {
    mount();
    typeInto(textarea(), "kept");
    click(micButton());
    await flush();
    click(discardButton());
    await flush();
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    expect(FakeMediaRecorder.instances[0].state).toBe("inactive");
    expect(mockTranscribeBlob).not.toHaveBeenCalled();
    expect(textarea().value).toBe("kept");
    expect(micButton().getAttribute("data-voice-phase")).toBe("idle");
    expect(discardButton()).toBeNull();
    expect(alertLine()).toBeNull();
    expect(currentMicrophoneOwner()).toBeNull();
    expect(onInsertText).not.toHaveBeenCalled();
  });

  test("11. unmounting mid-recording stops the tracks and releases the microphone", async () => {
    mount();
    click(micButton());
    await flush();
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
    act(() => root.unmount());
    root = null;
    for (const t of tracks) expect(t.stop).toHaveBeenCalled();
    expect(currentMicrophoneOwner()).toBeNull();
    expect(mockTranscribeBlob).not.toHaveBeenCalled();
  });
});

describe("12. failures surface on the composer's own error line", () => {
  test("a transport failure is worded for the user and the draft is unchanged", async () => {
    mount();
    typeInto(textarea(), "kept");
    mockTranscribeBlob.mockImplementation(async () => {
      throw new Error("Network error");
    });
    await dictate();
    expect(alertLine().textContent).toBe(LIVE_TRANSCRIPT_MESSAGE.NETWORK);
    expect(textarea().value).toBe("kept");
    expect(micButton().getAttribute("data-voice-phase")).toBe("idle");
    expect(micButton().disabled).toBe(false);
  });

  test("a blocked microphone is worded for the user and nothing records", async () => {
    mount();
    getUserMedia.mockImplementation(async () => {
      const e = new Error("Permission denied");
      e.name = "NotAllowedError";
      throw e;
    });
    click(micButton());
    await flush();
    expect(alertLine().textContent).toBe(LIVE_TRANSCRIPT_MESSAGE.MIC_BLOCKED);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(micButton().getAttribute("data-voice-phase")).toBe("idle");
    expect(currentMicrophoneOwner()).toBeNull();
  });

  test("a silent clip says so, and an empty transcription adds nothing", async () => {
    mount();
    FakeMediaRecorder.clipBytes = 0;
    await dictate();
    expect(mockTranscribeBlob).not.toHaveBeenCalled();
    expect(alertLine().textContent).toBe(DICTATION_MESSAGE.NO_SPEECH);

    FakeMediaRecorder.clipBytes = 8;
    mockTranscribeBlob.mockImplementation(async () => "   ");
    await dictate();
    expect(mockTranscribeBlob).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe("");
    expect(alertLine().textContent).toBe(DICTATION_MESSAGE.NO_SPEECH);
  });

  test("starting a new dictation clears the previous failure line", async () => {
    mount();
    mockTranscribeBlob.mockImplementation(async () => {
      throw new Error("Network error");
    });
    await dictate();
    expect(alertLine()).not.toBeNull();
    click(micButton());
    await flush();
    expect(alertLine()).toBeNull();
  });
});

describe("13. one recorder at a time", () => {
  test("Dictate refuses to start while Live transcript holds the microphone", async () => {
    mount();
    claimMicrophone(MICROPHONE_OWNER.LIVE_TRANSCRIPT);
    click(micButton());
    await flush();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(alertLine().textContent).toBe(DICTATION_MESSAGE.MIC_OWNED_BY_LIVE_TRANSCRIPT);
    expect(micButton().getAttribute("data-voice-phase")).toBe("idle");
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LIVE_TRANSCRIPT);
    // Once Live transcript lets go, dictation works again.
    releaseMicrophone(MICROPHONE_OWNER.LIVE_TRANSCRIPT);
    click(micButton());
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(micButton().getAttribute("data-voice-phase")).toBe("recording");
  });

  const LiveProbe = forwardRef(function LiveProbe(_props, ref) {
    const session = useLiveTranscript();
    useImperativeHandle(ref, () => session, [session]);
    return null;
  });

  test("Live transcript refuses to start while a Quick Add dictation is recording, and starts once it is done", async () => {
    mount();
    const probe = React.createRef();
    const probeHost = document.createElement("div");
    document.body.appendChild(probeHost);
    const probeRoot = createRoot(probeHost);
    act(() => probeRoot.render(<LiveProbe ref={probe} />));

    click(micButton());
    await flush();
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
    let started;
    await act(async () => {
      started = await probe.current.start();
    });
    expect(started).toBe(false);
    expect(probe.current.state.error.message).toBe(LIVE_TRANSCRIPT_MESSAGE.MIC_IN_USE);
    expect(probe.current.state.status).toBe("idle");
    // Only the dictation's own stream was ever opened.
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    click(discardButton());
    await flush();
    expect(currentMicrophoneOwner()).toBeNull();
    await act(async () => {
      started = await probe.current.start();
    });
    expect(started).toBe(true);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LIVE_TRANSCRIPT);
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    act(() => probe.current.stop());
    await flush();
    expect(currentMicrophoneOwner()).toBeNull();
    act(() => probeRoot.unmount());
    probeHost.remove();
  });
});

describe("15. Template Quick Add dictates too — no Free-form editor is required", () => {
  test("with a selected Template row and no editor, the text lands in the draft and Send takes the composer route", async () => {
    mount({ editor: null, target: templateRow, targetToken: "note-1|row-1" });
    await dictate();
    expect(textarea().value).toBe("Hello site");
    expect(onInsertText).not.toHaveBeenCalled();
    expect(onSendComposer).not.toHaveBeenCalled();
    click(sendButton());
    await flush();
    expect(onSendComposer).toHaveBeenCalledTimes(1);
    expect(onSendComposer.mock.calls[0][0].text).toBe("Hello site");
    expect(onInsertText).not.toHaveBeenCalled();
  });
});

/* ------------------------- dictation language ---------------------------- */

describe("L1. the composer shows the current dictation language beside Dictate", () => {
  test("defaults to Auto-detect, offers exactly the supported list, and is named for dictation", () => {
    mount();
    const select = languageSelect();
    expect(select).not.toBeNull();
    expect(select.value).toBe("auto");
    expect(languageFace().textContent).toBe("Auto");
    expect(select.getAttribute("title")).toBe("Dictation language: Auto-detect");
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual(
      TRANSCRIPTION_LANGUAGES.map((l) => [l.value, l.label])
    );
    // It sits in the same control cluster, immediately before the Dictate control.
    const wrapper = select.closest(".nw-voice-lang-compact");
    expect(wrapper.nextElementSibling.contains(micButton())).toBe(true);
    // The face is decoration; the native select carries the name and value.
    expect(host.querySelector(".nw-voice-lang-compact-face").getAttribute("aria-hidden")).toBe("true");
  });

  test("the note's remembered transcription language is the default", () => {
    saveTranscriptionLanguage("note-1", "af");
    mount();
    expect(languageSelect().value).toBe("af");
    expect(languageFace().textContent).toBe("AF");
    expect(languageSelect().getAttribute("title")).toBe("Dictation language: Afrikaans");
  });

  test("opening another note shows that note's remembered language", () => {
    saveTranscriptionLanguage("note-2", "fr");
    mount();
    expect(languageFace().textContent).toBe("Auto");
    noteId = "note-2";
    render({ targetToken: "note-2|freeform" });
    expect(languageSelect().value).toBe("fr");
    expect(languageFace().textContent).toBe("FR");
  });

  test("a disabled composer disables the language control too", () => {
    mount({ disabled: true });
    expect(languageSelect().disabled).toBe(true);
    expect(languageSelect().closest(".nw-voice-lang-compact").getAttribute("data-disabled")).toBe("true");
  });
});

describe("L2/L3. choosing a language updates the control and the shared per-note memory", () => {
  test("the choice is shown, remembered under the one existing key, and is the default next time", () => {
    mount();
    // The composer already remembers other per-note preferences (the
    // coordinate system); choosing a language adds the language memory and
    // changes nothing else.
    const before = Object.fromEntries(storedKeys().map((k) => [k, localStorage.getItem(k)]));
    expect(before).not.toHaveProperty(TRANSCRIPTION_LANGUAGE_MEMORY_KEY);
    chooseLanguage("de");
    expect(languageSelect().value).toBe("de");
    expect(languageFace().textContent).toBe("DE");
    expect(loadTranscriptionLanguage("note-1")).toBe("de");
    expect(loadTranscriptionLanguage("note-2")).toBe("auto");
    const after = Object.fromEntries(storedKeys().map((k) => [k, localStorage.getItem(k)]));
    expect(Object.keys(after).filter((k) => !(k in before))).toEqual([TRANSCRIPTION_LANGUAGE_MEMORY_KEY]);
    for (const key of Object.keys(before)) expect(after[key]).toBe(before[key]);
    expect(JSON.parse(after[TRANSCRIPTION_LANGUAGE_MEMORY_KEY])).toEqual({ "note-1": "de" });

    act(() => root.unmount());
    host.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    render({});
    expect(languageSelect().value).toBe("de");
    expect(languageFace().textContent).toBe("DE");
  });
});

describe("L4. a dictation is transcribed in the selected language", () => {
  test("the transport receives the chosen language", async () => {
    mount();
    chooseLanguage("es");
    await dictate();
    expect(mockTranscribeBlob).toHaveBeenCalledTimes(1);
    expect(mockTranscribeBlob.mock.calls[0][1]).toBe("es");
    expect(textarea().value).toBe("Hello site");
  });

  test("a remembered language is used without touching the control", async () => {
    saveTranscriptionLanguage("note-1", "pt");
    mount();
    await dictate();
    expect(mockTranscribeBlob.mock.calls[0][1]).toBe("pt");
  });
});

describe("L5/L6. the language is captured when recording starts", () => {
  test("changing the language WHILE RECORDING leaves the clip in its starting language; the next clip uses the new one", async () => {
    mount();
    chooseLanguage("fr");
    click(micButton());
    await flush();
    expect(micButton().getAttribute("data-voice-phase")).toBe("recording");
    // Still available mid-dictation, and it says a change applies next time.
    expect(languageSelect().disabled).toBe(false);
    chooseLanguage("de");
    expect(languageSelect().getAttribute("title")).toBe(
      "Dictation language: German — a change applies to the next dictation"
    );
    click(micButton());
    await flush();
    expect(mockTranscribeBlob.mock.calls[0][1]).toBe("fr");
    expect(textarea().value).toBe("Hello site");
    expect(languageFace().textContent).toBe("DE");
    expect(languageSelect().getAttribute("title")).toBe("Dictation language: German");

    await dictate();
    expect(mockTranscribeBlob).toHaveBeenCalledTimes(2);
    expect(mockTranscribeBlob.mock.calls[1][1]).toBe("de");
    expect(textarea().value).toBe("Hello site Hello site");
  });

  test("changing the language WHILE TRANSCRIBING does not change the in-flight clip's language or result", async () => {
    mount();
    chooseLanguage("fr");
    let resolveText;
    mockTranscribeBlob.mockImplementation(() => new Promise((resolve) => (resolveText = resolve)));
    click(micButton());
    await flush();
    click(micButton());
    await flush();
    expect(micButton().getAttribute("data-voice-phase")).toBe("transcribing");
    expect(mockTranscribeBlob.mock.calls[0][1]).toBe("fr");
    expect(languageSelect().disabled).toBe(false);
    chooseLanguage("ja");
    expect(loadTranscriptionLanguage("note-1")).toBe("ja");
    await act(async () => resolveText("bonjour le chantier"));
    await flush();
    // One request, in the starting language; the text lands in the draft as usual.
    expect(mockTranscribeBlob).toHaveBeenCalledTimes(1);
    expect(mockTranscribeBlob.mock.calls[0][1]).toBe("fr");
    expect(textarea().value).toBe("bonjour le chantier");
    expect(alertLine()).toBeNull();
  });
});

describe("L7–L9. the language control opens nothing and touches nothing but the language", () => {
  test("choosing a language opens no Live transcript UI, records nothing, and leaves the draft and staged attachments intact", async () => {
    mount();
    typeInto(textarea(), "Existing note");
    choose(pickerInput(), [new File([new Uint8Array(16)], "notes.txt", { type: "text/plain" })]);
    chooseLanguage("ja");
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[aria-haspopup="dialog"]')).toBeNull();
    expect(host.textContent).not.toMatch(/Live transcript/);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(currentMicrophoneOwner()).toBeNull();
    expect(mockTranscribeBlob).not.toHaveBeenCalled();
    expect(textarea().value).toBe("Existing note");
    expect(host.querySelectorAll(".nw-quickadd-staged-item")).toHaveLength(1);
    expect(onInsertText).not.toHaveBeenCalled();
    expect(onSendComposer).not.toHaveBeenCalled();
    expect(alertLine()).toBeNull();

    // A dictation in the chosen language still only joins the draft.
    await dictate();
    expect(mockTranscribeBlob.mock.calls[0][1]).toBe("ja");
    expect(textarea().value).toBe("Existing note Hello site");
    expect(host.querySelectorAll(".nw-quickadd-staged-item")).toHaveLength(1);
    expect(onInsertText).not.toHaveBeenCalled();
    expect(onSendComposer).not.toHaveBeenCalled();
  });
});

describe("L10. Template Quick Add dictates in the chosen language", () => {
  test("a selected Template row with no editor: chosen language → draft → composer Send", async () => {
    mount({ editor: null, target: templateRow, targetToken: "note-1|row-1" });
    chooseLanguage("nl");
    await dictate();
    expect(mockTranscribeBlob.mock.calls[0][1]).toBe("nl");
    expect(textarea().value).toBe("Hello site");
    expect(onSendComposer).not.toHaveBeenCalled();
    click(sendButton());
    await flush();
    expect(onSendComposer).toHaveBeenCalledTimes(1);
    expect(onSendComposer.mock.calls[0][0].text).toBe("Hello site");
    expect(onInsertText).not.toHaveBeenCalled();
  });
});
