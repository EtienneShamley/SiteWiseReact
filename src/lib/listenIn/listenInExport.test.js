// src/lib/listenIn/listenInExport.test.js
//
// WHAT A LISTEN IN EXPORT CONTAINS (Phase 8D.1 UI correction) — the pure part.
//
// The document is built once, as HTML, and handed to the canonical NoteWise
// producers; plain text is the one adapter this module adds. So these tests
// are about CONTENT and ORDER, which is what the user actually gets, rather
// than about PDF or DOCX internals that the shared pipeline already owns.
import {
  LISTEN_IN_EXPORT_CONTENT,
  LISTEN_IN_EXPORT_CONTENT_ORDER,
  LISTEN_IN_EXPORT_FORMAT,
  LISTEN_IN_EXPORT_FORMAT_ORDER,
  buildListenInExportHtml,
  buildListenInPlainText,
  isListenInExportContent,
  isListenInExportFormat,
  listenInExportContentLabel,
  listenInExportFormatLabel,
  listenInExportMeta,
  listenInExportTitle,
  listenInTranscriptParagraphs,
  listenInActionItemLine,
  listenInSummaryDocument,
  hasListenInSummaryDocument,
} from "./listenInExport";
import { CHUNK_STATE } from "./listenInModel";

const SESSION = {
  title: "Listen In — 12 Sep 2026, 14:05",
  startedAt: Date.UTC(2026, 8, 12, 4, 5),
  stoppedAt: Date.UTC(2026, 8, 12, 5, 5),
  language: "en",
};
const SUMMARY = { text: "The slab was poured.\n\n- Order rebar\n- Book the inspector" };
const CHUNKS = [
  { seq: 0, state: CHUNK_STATE.TRANSCRIBED, text: "First thing said." },
  { seq: 1, state: CHUNK_STATE.EMPTY, text: "" },
  { seq: 2, state: CHUNK_STATE.TRANSCRIBED, text: "Second thing said." },
  { seq: 3, state: CHUNK_STATE.TRANSCRIBED, text: "Third thing said." },
];

const html = (content) =>
  buildListenInExportHtml({ session: SESSION, chunks: CHUNKS, summary: SUMMARY, content });
const text = (content) =>
  buildListenInPlainText({ session: SESSION, chunks: CHUNKS, summary: SUMMARY, content });

/* ============================== the choices ============================== */

describe("the locked choices", () => {
  test("exactly five formats, in a fixed order, with the product's labels", () => {
    expect(LISTEN_IN_EXPORT_FORMAT_ORDER).toEqual(["pdf", "docx", "md", "txt", "html"]);
    expect(LISTEN_IN_EXPORT_FORMAT_ORDER.map(listenInExportFormatLabel)).toEqual([
      "PDF",
      "Word",
      "Markdown",
      "Plain Text",
      "HTML",
    ]);
    // No spreadsheet formats for a whole session, and nothing obscure.
    for (const absent of ["csv", "xlsx", "json", "rtf", "odt", "epub"]) {
      expect(LISTEN_IN_EXPORT_FORMAT_ORDER).not.toContain(absent);
      expect(isListenInExportFormat(absent)).toBe(false);
    }
  });

  test("exactly three content choices", () => {
    expect(LISTEN_IN_EXPORT_CONTENT_ORDER).toEqual(["summary", "transcript", "both"]);
    expect(LISTEN_IN_EXPORT_CONTENT_ORDER.map(listenInExportContentLabel)).toEqual([
      "Summary",
      "Transcript",
      "Summary + Transcript",
    ]);
    expect(isListenInExportContent("audio")).toBe(false);
  });
});

/* ============================== the content ============================== */

describe("Summary exports the summary and NOT the transcript", () => {
  test("in HTML", () => {
    const out = html(LISTEN_IN_EXPORT_CONTENT.SUMMARY);
    expect(out).toContain("<h2>Summary</h2>");
    expect(out).toContain("The slab was poured.");
    expect(out).not.toContain("<h2>Transcript</h2>");
    expect(out).not.toContain("First thing said.");
    expect(out).not.toContain("Third thing said.");
  });

  test("in plain text", () => {
    const out = text(LISTEN_IN_EXPORT_CONTENT.SUMMARY);
    expect(out).toContain("Summary");
    expect(out).toContain("The slab was poured.");
    expect(out).not.toContain("Transcript");
    expect(out).not.toContain("First thing said.");
  });
});

describe("Transcript exports the COMPLETE transcript in order", () => {
  test("every transcribed chunk, in sequence, and no summary", () => {
    const out = html(LISTEN_IN_EXPORT_CONTENT.TRANSCRIPT);
    expect(out).toContain("<h2>Transcript</h2>");
    expect(out).not.toContain("<h2>Summary</h2>");
    expect(out).not.toContain("The slab was poured.");
    const order = ["First thing said.", "Second thing said.", "Third thing said."].map((t) =>
      out.indexOf(t)
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("it is built from the SESSION's chunks, not from what a view rendered", () => {
    // Chunks handed over out of order still export in speaking order.
    const shuffled = [CHUNKS[3], CHUNKS[0], CHUNKS[2], CHUNKS[1]];
    const out = buildListenInExportHtml({
      session: SESSION,
      chunks: shuffled,
      content: LISTEN_IN_EXPORT_CONTENT.TRANSCRIPT,
    });
    const order = ["First thing said.", "Second thing said.", "Third thing said."].map((t) =>
      out.indexOf(t)
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("a silent chunk is not a paragraph; a FAILED one is named rather than hidden", () => {
    const paragraphs = listenInTranscriptParagraphs([
      { seq: 0, state: CHUNK_STATE.TRANSCRIBED, text: "kept" },
      { seq: 1, state: CHUNK_STATE.EMPTY, text: "" },
      { seq: 2, state: CHUNK_STATE.FAILED, text: "" },
      { seq: 3, state: CHUNK_STATE.SEALED, text: "" },
    ]);
    expect(paragraphs.map((p) => p.kind)).toEqual(["text", "gap"]);
    expect(paragraphs[1].text).toMatch(/could not be transcribed/);
  });
});

describe("Summary + Transcript contains both, summary first", () => {
  test("in HTML", () => {
    const out = html(LISTEN_IN_EXPORT_CONTENT.BOTH);
    expect(out.indexOf("<h2>Summary</h2>")).toBeGreaterThan(-1);
    expect(out.indexOf("<h2>Summary</h2>")).toBeLessThan(out.indexOf("<h2>Transcript</h2>"));
    expect(out).toContain("The slab was poured.");
    expect(out).toContain("First thing said.");
    expect(out).toContain("Third thing said.");
  });

  test("in plain text, with no Markdown syntax", () => {
    const out = text(LISTEN_IN_EXPORT_CONTENT.BOTH);
    expect(out.indexOf("Summary")).toBeLessThan(out.indexOf("Transcript"));
    expect(out).toContain("The slab was poured.");
    expect(out).toContain("Third thing said.");
    expect(out).not.toMatch(/^#|<\/?[a-z]/im);
  });

  test("the document is headed and structured the same way in both", () => {
    expect(html(LISTEN_IN_EXPORT_CONTENT.BOTH)).toContain("<h1>Listen In — 12 Sep 2026, 14:05</h1>");
    expect(text(LISTEN_IN_EXPORT_CONTENT.BOTH)).toMatch(/^Listen In — 12 Sep 2026, 14:05\n=+/);
  });
});

/* ============================== the details ============================== */

describe("bullets, metadata and escaping", () => {
  test("a bullet block becomes a real list, so Word and PDF render one", () => {
    const out = html(LISTEN_IN_EXPORT_CONTENT.SUMMARY);
    expect(out).toContain("<ul><li>Order rebar</li><li>Book the inspector</li></ul>");
  });

  test("metadata is only what the session actually records — nothing is invented", () => {
    const full = listenInExportMeta(SESSION, { formatDate: (ms) => `T${ms}` });
    expect(full).toHaveLength(3);
    // A session that never stopped says nothing about an end.
    const running = listenInExportMeta(
      { startedAt: 10, stoppedAt: null, language: "auto" },
      { formatDate: (ms) => `T${ms}` }
    );
    expect(running).toEqual(["Started T10"]);
    // Auto-detect is not a language worth stating.
    expect(running.join(" ")).not.toMatch(/Language/);
    expect(listenInExportMeta(null)).toEqual([]);
  });

  test("an untitled session falls back to the feature name, never to a note's title", () => {
    expect(listenInExportTitle({ title: "  " })).toBe("Listen In");
    expect(listenInExportTitle(null)).toBe("Listen In");
    expect(listenInExportTitle({ title: "Site walk" })).toBe("Site walk");
  });

  test("spoken text cannot inject markup into the document", () => {
    const out = buildListenInExportHtml({
      session: { title: "A & B <script>" },
      chunks: [{ seq: 0, state: CHUNK_STATE.TRANSCRIBED, text: "he said <b>no</b> & left" }],
      content: LISTEN_IN_EXPORT_CONTENT.TRANSCRIPT,
    });
    expect(out).toContain("A &amp; B &lt;script&gt;");
    expect(out).toContain("he said &lt;b&gt;no&lt;/b&gt; &amp; left");
    expect(out).not.toContain("<b>no</b>");
  });

  test("an absent summary or transcript is stated honestly rather than left blank", () => {
    const noSummary = buildListenInExportHtml({
      session: SESSION,
      chunks: CHUNKS,
      summary: null,
      content: LISTEN_IN_EXPORT_CONTENT.BOTH,
    });
    expect(noSummary).toMatch(/No summary has been generated/);
    const noTranscript = buildListenInExportHtml({
      session: SESSION,
      chunks: [],
      summary: SUMMARY,
      content: LISTEN_IN_EXPORT_CONTENT.BOTH,
    });
    expect(noTranscript).toMatch(/No speech was transcribed/);
  });
});

/* ===================== the STRUCTURED summary (8D.2) ===================== */
//
// Since Phase 8D.2 the summary a session carries is structured meeting
// intelligence, not one block of text, and an export must contain the whole of
// it — derived once so the PDF, the Word document, the Markdown, the HTML and
// the plain text cannot disagree.

const STRUCTURED = {
  text: "The team walked the site.\n\nCosts were reviewed.",
  result: {
    summaryText: "The team walked the site.\n\nCosts were reviewed.",
    keyPoints: ["Three boreholes were logged."],
    decisions: ["The survey moves to Friday."],
    actionItems: [
      { task: "Send the borehole logs", owner: "Priya", dueDate: "Friday", sourceSeq: 1 },
      { task: "Chase the rig quote", owner: null, dueDate: null, sourceSeq: null },
    ],
    risks: ["Rain may stop work."],
    followUps: [],
  },
  note: "",
};

describe("a structured summary is exported in full", () => {
  test("every non-empty section appears, under its heading, in the fixed order", () => {
    const out = buildListenInExportHtml({
      session: SESSION,
      chunks: CHUNKS,
      summary: STRUCTURED,
      content: LISTEN_IN_EXPORT_CONTENT.SUMMARY,
    });
    expect(out).toContain("The team walked the site.");
    for (const heading of ["Key points", "Decisions", "Action items", "Risks and issues"]) {
      expect(out).toContain(`<h3>${heading}</h3>`);
    }
    expect(out.indexOf("Key points")).toBeLessThan(out.indexOf("Decisions"));
    expect(out.indexOf("Decisions")).toBeLessThan(out.indexOf("Action items"));
    expect(out.indexOf("Action items")).toBeLessThan(out.indexOf("Risks and issues"));
    // An EMPTY section is omitted rather than printed as a finding of none.
    expect(out).not.toContain("Follow-ups");
  });

  test("AN OWNER OR A DUE DATE APPEARS ONLY WHERE ONE WAS STATED", () => {
    const out = buildListenInExportHtml({
      session: SESSION,
      chunks: CHUNKS,
      summary: STRUCTURED,
      content: LISTEN_IN_EXPORT_CONTENT.SUMMARY,
    });
    expect(out).toContain("Send the borehole logs (Priya, due Friday)");
    expect(out).toContain("<li>Chase the rig quote</li>");
    expect(out).not.toMatch(/TBD|unknown|N\/A|due null/i);
  });

  test("one action item is rendered as one readable line", () => {
    expect(listenInActionItemLine({ task: "Do it", owner: "Sam", dueDate: "Monday" })).toBe(
      "Do it (Sam, due Monday)"
    );
    expect(listenInActionItemLine({ task: "Do it", owner: "Sam", dueDate: null })).toBe("Do it (Sam)");
    expect(listenInActionItemLine({ task: "Do it", owner: null, dueDate: "Monday" })).toBe(
      "Do it (due Monday)"
    );
    expect(listenInActionItemLine({ task: "Do it", owner: null, dueDate: null })).toBe("Do it");
    expect(listenInActionItemLine({ task: "  " })).toBe("");
    expect(listenInActionItemLine(null)).toBe("");
  });

  test("plain text carries the same sections with no markup at all", () => {
    const out = buildListenInPlainText({
      session: SESSION,
      chunks: CHUNKS,
      summary: STRUCTURED,
      content: LISTEN_IN_EXPORT_CONTENT.SUMMARY,
    });
    expect(out).toContain("Key points");
    expect(out).toContain("- Three boreholes were logged.");
    expect(out).toContain("- Send the borehole logs (Priya, due Friday)");
    expect(out).not.toMatch(/<[a-z]/i);
  });

  test("Summary + Transcript keeps the summary FIRST, structure and all", () => {
    const out = buildListenInExportHtml({
      session: SESSION,
      chunks: CHUNKS,
      summary: STRUCTURED,
      content: LISTEN_IN_EXPORT_CONTENT.BOTH,
    });
    expect(out.indexOf("Key points")).toBeLessThan(out.indexOf("<h2>Transcript</h2>"));
    expect(out.indexOf("Risks and issues")).toBeLessThan(out.indexOf("First thing said."));
  });

  test("INCOMPLETE COVERAGE IS STATED IN THE FILE, not only on screen", () => {
    const note = "This summary does not cover the whole recording: One part could not be transcribed.";
    const html5 = buildListenInExportHtml({
      session: SESSION,
      chunks: CHUNKS,
      summary: { ...STRUCTURED, note },
      content: LISTEN_IN_EXPORT_CONTENT.SUMMARY,
    });
    expect(html5).toContain(note);
    const txt = buildListenInPlainText({
      session: SESSION,
      chunks: CHUNKS,
      summary: { ...STRUCTURED, note },
      content: LISTEN_IN_EXPORT_CONTENT.SUMMARY,
    });
    expect(txt).toContain(note);
  });

  test("the old text-only summary shape still exports, unchanged", () => {
    const out = buildListenInExportHtml({
      session: SESSION,
      chunks: CHUNKS,
      summary: SUMMARY,
      content: LISTEN_IN_EXPORT_CONTENT.SUMMARY,
    });
    expect(out).toContain("The slab was poured.");
    expect(out).toContain("<li>Order rebar</li>");
  });

  test("the derivation is one document, and knows when there is nothing in it", () => {
    const doc = listenInSummaryDocument(STRUCTURED);
    expect(doc.paragraphs).toEqual(["The team walked the site.", "Costs were reviewed."]);
    expect(doc.sections.map((s) => s.heading)).toEqual([
      "Key points",
      "Decisions",
      "Action items",
      "Risks and issues",
    ]);
    expect(hasListenInSummaryDocument(STRUCTURED)).toBe(true);
    expect(hasListenInSummaryDocument(null)).toBe(false);
    expect(hasListenInSummaryDocument({ text: "", result: null })).toBe(false);
  });

  test("spoken text in a structured section cannot inject markup", () => {
    const out = buildListenInExportHtml({
      session: SESSION,
      chunks: [],
      summary: {
        text: "ok",
        result: { ...STRUCTURED.result, risks: ["<script>alert(1)</script>"], actionItems: [] },
      },
      content: LISTEN_IN_EXPORT_CONTENT.SUMMARY,
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});
