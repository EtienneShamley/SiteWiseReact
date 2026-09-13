// src/lib/cloud/listenInCloudModel.test.js
//
// THE CLOUD SHAPE OF A LISTEN IN MEETING (Phase 8D.4), as pure functions:
// page math, the three projections, their signatures, the validators that
// read them back, the transcript reconstruction, the audio invariant, and
// the source-level tie between the model's field lists and firestore.rules.
import fs from "fs";
import path from "path";
import { CLOUD_COLLECTION, LISTEN_IN_MEETING_FIELDS, MAX_INLINE_PAYLOAD_UNITS, buildEntityDocument, readEntityDocument } from "./cloudModel";
import {
  LISTEN_IN_CLOUD_ENTITY,
  LISTEN_IN_CLOUD_LIMITS,
  SIGNATURE_VERSION,
  TRANSCRIPT_PAGE_SIZE,
  assembleCloudTranscript,
  assertNoBinaryInPayload,
  cloudSegmentsAsChunks,
  digestOfText,
  findBinaryInPayload,
  listenInDocumentEntity,
  listenInEntityDocument,
  parseTranscriptPageDocumentId,
  projectListenInMeeting,
  projectListenInSummary,
  projectListenInTranscriptPage,
  projectionSignature,
  transcribedThroughSeq,
  transcriptPageDocumentId,
  transcriptPageOf,
  transcriptPagesOf,
  validateListenInMeetingPayload,
  validateListenInSummaryPayload,
  validateListenInTranscriptPayload,
} from "./listenInCloudModel";
import { CHUNK_STATE, LISTEN_IN_STATE, createChunk, createSession, transcriptText } from "../listenIn/listenInModel";
import { LISTEN_IN_SUMMARY_STATUS, createSessionSummary, listenInActionItemId } from "../listenIn/listenInSummaryModel";

const UID = "uid-model";
const WS = "ws-model";
const SID = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";

function session(overrides = {}) {
  return createSession({ sessionId: SID, uid: UID, workspaceId: WS, startedAt: 1_700_000_000_000, language: "en", ...overrides });
}

function chunk(seq, state = CHUNK_STATE.TRANSCRIBED, text = `words ${seq}`) {
  const row = createChunk({
    uid: UID,
    workspaceId: WS,
    sessionId: SID,
    seq,
    mimeType: "audio/webm",
    byteLength: 180000,
    startedAt: 1_700_000_000_000 + seq * 30000,
    endedAt: 1_700_000_000_000 + (seq + 1) * 30000,
    language: "en",
  });
  return { ...row, state, text: state === CHUNK_STATE.TRANSCRIBED ? text : "", attempts: state === CHUNK_STATE.FAILED ? 5 : 0 };
}

/* ------------------------------ page math ------------------------------- */

describe("page math", () => {
  test("a page holds TRANSCRIPT_PAGE_SIZE consecutive sequence numbers and a four-hour meeting is eight pages", () => {
    expect(TRANSCRIPT_PAGE_SIZE).toBe(60);
    expect(transcriptPageOf(0)).toBe(0);
    expect(transcriptPageOf(59)).toBe(0);
    expect(transcriptPageOf(60)).toBe(1);
    expect(transcriptPageOf(479)).toBe(7);
    const fourHours = Array.from({ length: 480 }, (_, i) => chunk(i));
    expect(transcriptPagesOf(fourHours)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("a page document id names its meeting and its page, and parses back exactly", () => {
    expect(transcriptPageDocumentId(SID, 3)).toBe(`${SID}:3`);
    expect(parseTranscriptPageDocumentId(`${SID}:3`)).toEqual({ sessionId: SID, page: 3 });
    for (const bad of [`${SID}:`, `${SID}:-1`, `${SID}:03`, `${SID}:x`, ":3", SID, 42, null, `a:b:3`]) {
      expect(parseTranscriptPageDocumentId(bad)).toBeNull();
    }
  });

  test("entity names map to documents and back, and nothing else parses", () => {
    expect(listenInEntityDocument(SID, LISTEN_IN_CLOUD_ENTITY.MEETING)).toEqual({ collection: "listenInMeetings", id: SID });
    expect(listenInEntityDocument(SID, LISTEN_IN_CLOUD_ENTITY.SUMMARY)).toEqual({ collection: "listenInSummaries", id: SID });
    expect(listenInEntityDocument(SID, "transcript:2")).toEqual({ collection: "listenInTranscripts", id: `${SID}:2` });
    expect(listenInEntityDocument(SID, "transcript:x")).toBeNull();
    expect(listenInDocumentEntity("listenInMeetings", SID)).toEqual({ sessionId: SID, entity: "meeting", page: null });
    expect(listenInDocumentEntity("listenInTranscripts", `${SID}:2`)).toEqual({ sessionId: SID, entity: "transcript:2", page: 2 });
    expect(listenInDocumentEntity("nodes", SID)).toBeNull();
    expect(listenInDocumentEntity("listenInTranscripts", "nope")).toBeNull();
  });
});

/* ------------------------------ the header ------------------------------ */

describe("the meeting header projection", () => {
  test("carries identity, author, lifecycle, captured time, coverage and summary state — and no audio facts", () => {
    const s = session({ title: "Site walk" });
    const finished = { ...s, state: LISTEN_IN_STATE.FINISHED, stoppedAt: 5000, capturedMs: 90000, stopReason: "user", updatedAt: 6000 };
    const chunks = [chunk(0), chunk(1, CHUNK_STATE.FAILED), chunk(2), chunk(3, CHUNK_STATE.SEALED)];
    const summary = { ...createSessionSummary({ uid: UID, workspaceId: WS, sessionId: SID }), revision: 4, final: true, coveredThroughSeq: 2, status: LISTEN_IN_SUMMARY_STATUS.READY };
    const header = projectListenInMeeting({ session: finished, chunks, summary, revision: 7 });
    expect(header).toMatchObject({
      sessionId: SID,
      createdBy: UID,
      title: "Site walk",
      language: "en",
      state: "finished",
      stopReason: "user",
      stoppedAt: 5000,
      completedAt: 6000,
      capturedMs: 90000,
      revision: 7,
      segmentCount: 4,
      transcribedThroughSeq: 0,
      pendingCount: 1,
      failedSeqs: [1],
      transcriptPageCount: 1,
      transcriptPageSize: 60,
      summaryRevision: 4,
      summaryStatus: "ready",
      summaryFinal: true,
      summaryCoveredThroughSeq: 2,
    });
    for (const key of ["mimeType", "byteLength", "audio", "nextSeq", "text"]) expect(header).not.toHaveProperty(key);
    expect(Object.keys(header).every((k) => LISTEN_IN_MEETING_FIELDS.includes(k))).toBe(true);
  });

  test("a stopped (paused) meeting is not a completed one, and an active meeting has no completedAt", () => {
    const paused = { ...session(), state: LISTEN_IN_STATE.PAUSED, capturedMs: 30000 };
    const header = projectListenInMeeting({ session: paused, chunks: [], summary: null });
    expect(header.state).toBe("paused");
    expect(header.completedAt).toBeNull();
    expect(header.stoppedAt).toBeNull();
    expect(header.summaryStatus).toBeNull();
    expect(header.summaryRevision).toBe(0);
  });

  test("a summary request in flight on the recording device is not a cloud fact", () => {
    const generating = { ...createSessionSummary({ uid: UID, workspaceId: WS, sessionId: SID }), status: LISTEN_IN_SUMMARY_STATUS.GENERATING };
    expect(projectListenInMeeting({ session: session(), summary: generating }).summaryStatus).toBe("idle");
    const withParts = { ...generating, parts: [{ fromSeq: 0, toSeq: 1, result: {} }] };
    expect(projectListenInMeeting({ session: session(), summary: withParts }).summaryStatus).toBe("ready");
  });

  test("the signature ignores the revision and changes with content, so a seal that changes nothing costs no revision", () => {
    const a = projectListenInMeeting({ session: session(), chunks: [chunk(0)], revision: 1 });
    const b = projectListenInMeeting({ session: { ...session(), nextSeq: 9 }, chunks: [chunk(0)], revision: 2 });
    expect(projectionSignature(a)).toBe(projectionSignature(b));
    const c = projectListenInMeeting({ session: { ...session(), state: LISTEN_IN_STATE.PAUSED }, chunks: [chunk(0)], revision: 2 });
    expect(projectionSignature(c)).not.toBe(projectionSignature(a));
  });

  test("round-trips through the native envelope and the validator", () => {
    const header = projectListenInMeeting({ session: session(), chunks: [chunk(0)], revision: 1 });
    const built = buildEntityDocument({ workspaceId: WS, collection: CLOUD_COLLECTION.LISTEN_IN_MEETINGS, id: SID, payload: header });
    expect(built.chunks).toEqual([]);
    expect(built.fields).toMatchObject({ workspaceId: WS, id: SID, kind: "listenInMeetings", createdBy: UID, revision: 1 });
    const back = readEntityDocument({ workspaceId: WS, collection: CLOUD_COLLECTION.LISTEN_IN_MEETINGS, id: SID, fields: built.fields });
    expect(back.ok).toBe(true);
    const check = validateListenInMeetingPayload(back.payload, { id: SID });
    expect(check.ok).toBe(true);
    expect(check.meeting).toEqual(header);
  });

  test("the validator refuses an unknown field, a foreign id, a missing author, a bad state and a zero revision", () => {
    const header = projectListenInMeeting({ session: session(), chunks: [], revision: 1 });
    expect(validateListenInMeetingPayload({ ...header, audio: null }).reason).toMatch(/unknown-field/);
    expect(validateListenInMeetingPayload(header, { id: "other" }).reason).toBe("bad-session-id");
    expect(validateListenInMeetingPayload({ ...header, createdBy: "" }).reason).toBe("bad-created-by");
    expect(validateListenInMeetingPayload({ ...header, state: "idle" }).reason).toBe("bad-state");
    expect(validateListenInMeetingPayload({ ...header, state: "deleted" }).reason).toBe("bad-state");
    expect(validateListenInMeetingPayload({ ...header, revision: 0 }).reason).toBe("bad-revision");
    expect(validateListenInMeetingPayload({ ...header, failedSeqs: [1.5] }).reason).toBe("bad-failed-seqs");
    expect(validateListenInMeetingPayload({ ...header, title: "x".repeat(201) }).reason).toBe("bad-title");
    expect(validateListenInMeetingPayload(null).reason).toBe("bad-meeting-shape");
  });
});

/* ---------------------------- transcript pages -------------------------- */

describe("the transcript page projection", () => {
  test("holds only its page's segments, in sequence order, with text for transcribed segments only", () => {
    const rows = [chunk(61), chunk(0), chunk(60, CHUNK_STATE.FAILED), chunk(62, CHUNK_STATE.TRANSCRIBING), chunk(59), chunk(63, CHUNK_STATE.EMPTY)];
    const page = projectListenInTranscriptPage({ session: session(), chunks: rows, page: 1, revision: 3 });
    expect(page).toMatchObject({ sessionId: SID, createdBy: UID, page: 1, pageSize: 60, revision: 3 });
    expect(page.segments.map((s) => s.seq)).toEqual([60, 61, 62, 63]);
    expect(page.segments.map((s) => s.state)).toEqual(["failed", "transcribed", "sealed", "empty"]);
    expect(page.segments.map((s) => s.text)).toEqual(["", "words 61", "", ""]);
    expect(page.segments[1].offsetMs).toBe(61 * 30000);
    for (const s of page.segments) {
      expect(s).not.toHaveProperty("mimeType");
      expect(s).not.toHaveProperty("byteLength");
      expect(s).not.toHaveProperty("audio");
      expect(s).not.toHaveProperty("lastCode");
    }
  });

  test("round-trips through the JSON envelope with its hoisted fields, and the validator ties them to the payload", () => {
    const page = projectListenInTranscriptPage({ session: session(), chunks: [chunk(0), chunk(1)], page: 0, revision: 2 });
    const id = transcriptPageDocumentId(SID, 0);
    const built = buildEntityDocument({ workspaceId: WS, collection: CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS, id, payload: page });
    expect(built.fields).toMatchObject({ kind: "listenInTranscripts", sessionId: SID, createdBy: UID, page: 0, revision: 2 });
    expect(typeof built.fields.json).toBe("string");
    const back = readEntityDocument({ workspaceId: WS, collection: CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS, id, fields: built.fields });
    expect(back.ok).toBe(true);
    const check = validateListenInTranscriptPayload(back.payload, { id, fields: built.fields });
    expect(check.ok).toBe(true);
    expect(check.page.segments.map((s) => s.text)).toEqual(["words 0", "words 1"]);
    // hoisted fields that disagree with the JSON are a malformed document
    expect(validateListenInTranscriptPayload(back.payload, { id, fields: { ...built.fields, revision: 9 } }).reason).toBe("hoisted-mismatch");
    expect(validateListenInTranscriptPayload(back.payload, { id, fields: { ...built.fields, createdBy: "someone-else" } }).reason).toBe("hoisted-mismatch");
    expect(validateListenInTranscriptPayload({ ...page, createdBy: "" }).reason).toBe("bad-created-by");
    expect(validateListenInTranscriptPayload(back.payload, { id: `${SID}:1` }).reason).toBe("id-mismatch");
    expect(validateListenInTranscriptPayload({ ...page, segments: [{ ...page.segments[0], seq: 61 }] }).reason).toBe("segment-outside-page");
    expect(validateListenInTranscriptPayload({ ...page, segments: [{ ...page.segments[0], audio: "x" }] }).reason).toMatch(/unknown-segment-field/);
    expect(validateListenInTranscriptPayload({ ...page, segments: [page.segments[0], page.segments[0]] }).reason).toBe("duplicate-seq");
  });

  test("a four-hour transcript is eight bounded page documents, none near the document limit; an oversized page still chunks", () => {
    const fourHours = Array.from({ length: 480 }, (_, i) => chunk(i, CHUNK_STATE.TRANSCRIBED, "the eastern boundary drainage plan was agreed by everyone present ".repeat(9)));
    const pages = transcriptPagesOf(fourHours);
    expect(pages).toHaveLength(8);
    let totalSegments = 0;
    for (const page of pages) {
      const payload = projectListenInTranscriptPage({ session: session(), chunks: fourHours, page, revision: 1 });
      expect(payload.segments.length).toBeLessThanOrEqual(TRANSCRIPT_PAGE_SIZE);
      totalSegments += payload.segments.length;
      const built = buildEntityDocument({ workspaceId: WS, collection: CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS, id: transcriptPageDocumentId(SID, page), payload });
      expect(built.chunks).toEqual([]); // inline: well inside the budget
      expect(built.fields.json.length).toBeLessThan(MAX_INLINE_PAYLOAD_UNITS / 2);
    }
    expect(totalSegments).toBe(480);
    // A page that somehow carried more text than the inline budget is CHUNKED
    // by the same envelope every JSON entity uses, and reads back whole.
    const huge = projectListenInTranscriptPage({ session: session(), chunks: [chunk(0, CHUNK_STATE.TRANSCRIBED, "w".repeat(MAX_INLINE_PAYLOAD_UNITS + 10))], page: 0, revision: 1 });
    const built = buildEntityDocument({ workspaceId: WS, collection: CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS, id: transcriptPageDocumentId(SID, 0), payload: huge });
    expect(built.chunks.length).toBeGreaterThan(1);
    expect(built.fields.chunked).toBe(true);
    const back = readEntityDocument({ workspaceId: WS, collection: CLOUD_COLLECTION.LISTEN_IN_TRANSCRIPTS, id: transcriptPageDocumentId(SID, 0), fields: built.fields, chunks: built.chunks });
    expect(back.ok).toBe(true);
    expect(validateListenInTranscriptPayload(back.payload, { id: transcriptPageDocumentId(SID, 0), fields: built.fields }).ok).toBe(true);
  });

  test("transcribedThroughSeq stops at the first failed or pending segment", () => {
    expect(transcribedThroughSeq([chunk(0), chunk(1, CHUNK_STATE.EMPTY), chunk(2, CHUNK_STATE.FAILED), chunk(3)])).toBe(1);
    expect(transcribedThroughSeq([chunk(0, CHUNK_STATE.SEALED)])).toBe(-1);
    expect(transcribedThroughSeq([])).toBe(-1);
  });
});

/* ------------------------------ the summary ----------------------------- */

describe("the summary projection", () => {
  const result = {
    summaryText: "Drainage agreed.",
    keyPoints: ["Eastern boundary walked"],
    decisions: ["Drainage plan approved"],
    actionItems: [{ task: "Order pipes", owner: "Sam", dueDate: null, sourceSeq: 3 }, { task: "Book survey", owner: null, dueDate: null, sourceSeq: null }],
    risks: [],
    followUps: ["Confirm with council"],
  };

  test("carries the result with STABLE action-item ids and provenance, the parts, coverage and the user's wording — and no loop state", () => {
    const base = createSessionSummary({ uid: UID, workspaceId: WS, sessionId: SID, now: 100 });
    expect(base.uid).toBe(UID);
    const summary = {
      ...base,
      revision: 3,
      status: LISTEN_IN_SUMMARY_STATUS.READY,
      final: true,
      generatedAt: 500,
      coveredThroughSeq: 5,
      missingSeqs: [2],
      result,
      parts: [{ fromSeq: 0, toSeq: 5, result }],
      userSummaryText: "My own words.",
      userEditedAt: 600,
      attempts: 2,
      nextAttemptAt: 999,
      lastErrorOutcome: "failure",
      lastErrorMessage: "boom",
      lastRequestedAt: 400,
    };
    const payload = projectListenInSummary({ summary, revision: 2 });
    expect(payload).toMatchObject({ sessionId: SID, createdBy: UID, revision: 2, summaryRevision: 3, status: "ready", final: true, generatedAt: 500, coveredThroughSeq: 5, missingSeqs: [2], userSummaryText: "My own words.", userEditedAt: 600 });
    expect(payload.result.actionItems[0]).toEqual({ id: listenInActionItemId(SID, result.actionItems[0], 0), task: "Order pipes", owner: "Sam", dueDate: null, sourceSeq: 3 });
    expect(payload.result.actionItems[1].id).toBe(listenInActionItemId(SID, result.actionItems[1], 1));
    expect(payload.parts).toHaveLength(1);
    for (const key of ["attempts", "nextAttemptAt", "lastErrorOutcome", "lastErrorMessage", "lastRequestedAt", "uid", "workspaceId"]) {
      expect(payload).not.toHaveProperty(key);
    }
    // Regenerating the same items yields the same ids.
    expect(projectListenInSummary({ summary, revision: 9 }).result.actionItems.map((i) => i.id)).toEqual(payload.result.actionItems.map((i) => i.id));
  });

  test("round-trips through the JSON envelope and the validator, an empty summary included", () => {
    const summary = { ...createSessionSummary({ uid: UID, workspaceId: WS, sessionId: SID, now: 1 }), result, revision: 1, status: LISTEN_IN_SUMMARY_STATUS.READY };
    const payload = projectListenInSummary({ summary, revision: 1 });
    const built = buildEntityDocument({ workspaceId: WS, collection: CLOUD_COLLECTION.LISTEN_IN_SUMMARIES, id: SID, payload });
    expect(built.fields).toMatchObject({ kind: "listenInSummaries", sessionId: SID, createdBy: UID, revision: 1 });
    const back = readEntityDocument({ workspaceId: WS, collection: CLOUD_COLLECTION.LISTEN_IN_SUMMARIES, id: SID, fields: built.fields });
    const check = validateListenInSummaryPayload(back.payload, { id: SID, fields: built.fields });
    expect(check.ok).toBe(true);
    expect(check.summary.result.actionItems[0].id).toBe(payload.result.actionItems[0].id);
    const empty = projectListenInSummary({ summary: createSessionSummary({ uid: UID, workspaceId: WS, sessionId: SID, now: 1 }), revision: 1 });
    expect(validateListenInSummaryPayload(empty, { id: SID }).ok).toBe(true);
    expect(validateListenInSummaryPayload({ ...payload, revision: 0 }).reason).toBe("bad-revision");
    expect(validateListenInSummaryPayload({ ...payload, result: { summaryText: 5 } }).reason).toBe("bad-result");
    expect(validateListenInSummaryPayload(payload, { id: "other" }).reason).toBe("bad-session-id");
    expect(validateListenInSummaryPayload(payload, { id: SID, fields: { sessionId: SID, createdBy: UID, revision: 4 } }).reason).toBe("hoisted-mismatch");
    expect(validateListenInSummaryPayload({ ...payload, createdBy: "" }).reason).toBe("bad-created-by");
  });
});

/* --------------------------- reconstruction ----------------------------- */

describe("assembleCloudTranscript", () => {
  const page = (n, seqs, revision = 1) => ({ page: n, revision, segments: seqs.map((seq) => ({ seq, text: `t${seq}`, state: "transcribed" })) });

  test("orders pages and segments deterministically however they arrive", () => {
    const out = assembleCloudTranscript([page(1, [61, 60]), page(0, [2, 0, 1])]);
    expect(out.segments.map((s) => s.seq)).toEqual([0, 1, 2, 60, 61]);
    expect(out.pages).toEqual({ present: [0, 1], expected: 2, missing: [] });
  });

  test("names a missing page rather than skipping it, using the header's page count when known", () => {
    expect(assembleCloudTranscript([page(0, [0]), page(2, [120])]).pages).toEqual({ present: [0, 2], expected: 3, missing: [1] });
    expect(assembleCloudTranscript([page(0, [0])], { expectedPages: 3 }).pages).toEqual({ present: [0], expected: 3, missing: [1, 2] });
    expect(assembleCloudTranscript([]).pages).toEqual({ present: [], expected: 0, missing: [] });
  });

  test("two copies of one page resolve to the higher revision", () => {
    const out = assembleCloudTranscript([page(0, [0, 1], 1), { ...page(0, [0, 1, 2], 2) }]);
    expect(out.segments.map((s) => s.seq)).toEqual([0, 1, 2]);
  });

  test("cloud segments read as chunk rows the existing model already understands, with failures settled", () => {
    const meeting = { sessionId: SID, createdBy: UID };
    const rows = cloudSegmentsAsChunks(meeting, [
      { seq: 0, text: "hello", state: "transcribed", startedAt: 1, endedAt: 2, language: "en", recovered: false },
      { seq: 1, text: "", state: "failed", startedAt: 2, endedAt: 3, language: "en", recovered: false },
    ]);
    expect(transcriptText(rows)).toBe("hello");
    expect(rows[1].attempts).toBe(Number.MAX_SAFE_INTEGER);
    expect(rows[0].byteLength).toBe(0);
    expect(rows[0].mimeType).toBe("");
  });
});

/* -------------------------- the change signature ------------------------ */

describe("the projection signature is a digest, not the projection", () => {
  test("it is short and fixed-shape however large the projection, and holds no transcript text", () => {
    const words = "the eastern boundary drainage plan was agreed by everyone present ".repeat(40);
    const page = projectListenInTranscriptPage({
      session: session(),
      chunks: [chunk(0, CHUNK_STATE.TRANSCRIBED, words), chunk(1, CHUNK_STATE.TRANSCRIBED, words)],
      page: 0,
      revision: 1,
    });
    const signature = projectionSignature(page);
    expect(signature.startsWith(`${SIGNATURE_VERSION}:`)).toBe(true);
    expect(signature.length).toBeLessThan(40);
    // The words are in the projection and NOT in its signature.
    expect(JSON.stringify(page)).toContain("eastern boundary");
    expect(signature).not.toContain("eastern");
    expect(signature).not.toContain("boundary");
    for (const word of words.split(" ").filter((w) => w.length > 3)) {
      expect(signature.includes(word)).toBe(false);
    }
  });

  test("same projection → same signature; any change of content → a different one", () => {
    const base = { sessionId: SID, createdBy: UID, page: 0, segments: [{ seq: 0, text: "one" }] };
    expect(projectionSignature(base)).toBe(projectionSignature({ ...base }));
    // The revision is deliberately excluded, so bumping it alone changes nothing.
    expect(projectionSignature({ ...base, revision: 9 })).toBe(projectionSignature({ ...base, revision: 1 }));
    const changes = [
      { ...base, segments: [{ seq: 0, text: "two" }] },
      { ...base, segments: [{ seq: 1, text: "one" }] },
      { ...base, segments: [] },
      { ...base, segments: [{ seq: 0, text: "one" }, { seq: 1, text: "two" }] },
      { ...base, createdBy: "someone-else" },
      { ...base, page: 1 },
    ];
    const seen = new Set([projectionSignature(base)]);
    for (const changed of changes) {
      const signature = projectionSignature(changed);
      expect(seen.has(signature)).toBe(false);
      seen.add(signature);
    }
  });

  test("the digest is deterministic across calls, sensitive to single characters and to length", () => {
    expect(digestOfText("abc")).toBe(digestOfText("abc"));
    expect(digestOfText("abc")).not.toBe(digestOfText("abd"));
    expect(digestOfText("abc")).not.toBe(digestOfText("acb"));
    expect(digestOfText("abc")).not.toBe(digestOfText("abc "));
    expect(digestOfText("")).toBe(digestOfText(""));
    expect(digestOfText("").startsWith(`${SIGNATURE_VERSION}:0:`)).toBe(true);
    // The canonical length travels in it, so a collision needs both to match.
    expect(digestOfText("hello world").split(":")[1]).toBe("11");
  });
});

/* ------------------------------ the invariant --------------------------- */

describe("no binary may enter a Listen In cloud payload", () => {
  test("a Blob, an ArrayBuffer, a typed array or a live audio field is found at any depth", () => {
    expect(findBinaryInPayload({ a: 1, b: "x", c: [1, { d: null }] })).toBeNull();
    expect(findBinaryInPayload({ segments: [{ seq: 0, audio: new Blob(["x"]) }] })).toBe("$.segments[0].audio");
    expect(findBinaryInPayload({ deep: { bytes: new ArrayBuffer(4) } })).toBe("$.deep.bytes");
    expect(findBinaryInPayload({ deep: [new Uint8Array(2)] })).toBe("$.deep[0]");
    expect(findBinaryInPayload({ audio: "not-null" })).toBe("$.audio");
    expect(findBinaryInPayload({ audio: null })).toBeNull();
    expect(() => assertNoBinaryInPayload({ x: new Blob(["y"]) })).toThrow(/binary data/);
    expect(assertNoBinaryInPayload({ ok: true })).toEqual({ ok: true });
  });

  test("no projection of a chunk row with audio-shaped fields carries them", () => {
    const rows = [{ ...chunk(0), audio: new Blob(["bytes"]) }];
    const page = projectListenInTranscriptPage({ session: session(), chunks: rows, page: 0, revision: 1 });
    const header = projectListenInMeeting({ session: session(), chunks: rows, revision: 1 });
    expect(findBinaryInPayload(page)).toBeNull();
    expect(findBinaryInPayload(header)).toBeNull();
    expect(JSON.stringify(page)).not.toMatch(/mimeType|byteLength|audio/);
  });
});

/* ---------------------- the tie to firestore.rules ---------------------- */

describe("the model and firestore.rules say the same thing", () => {
  const rules = fs.readFileSync(path.join(__dirname, "..", "..", "..", "firestore.rules"), "utf8");

  test("the meeting header's closed field list is the rules' hasOnly list", () => {
    const block = rules.slice(rules.indexOf("function validListenInMeeting("), rules.indexOf("match /listenInMeetings/"));
    const hasOnly = block.slice(block.indexOf("hasOnly(["), block.indexOf("])", block.indexOf("hasOnly([")));
    const listed = [...hasOnly.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(listed).toEqual(["workspaceId", "id", "kind", "schemaVersion", "updatedAt", ...LISTEN_IN_MEETING_FIELDS]);
  });

  test("the rules carry the same enums and caps the validators enforce", () => {
    expect(rules).toMatch(/d\.state in \['recording', 'paused', 'stopping', 'finishing', 'finished', 'interrupted'\]/);
    expect(rules).toMatch(/d\.stopReason in \['user', 'error', 'interruption', 'limit'\]/);
    expect(rules).toMatch(/d\.summaryStatus in \['idle', 'ready', 'failed'\]/);
    expect(rules).toMatch(new RegExp(`d\\.title\\.size\\(\\) <= ${LISTEN_IN_CLOUD_LIMITS.titleChars}`));
    expect(rules).toMatch(new RegExp(`d\\.language\\.size\\(\\) <= ${LISTEN_IN_CLOUD_LIMITS.languageChars}`));
    expect(rules).toMatch(new RegExp(`d\\.failedSeqs\\.size\\(\\) <= ${LISTEN_IN_CLOUD_LIMITS.failedSeqs}`));
    // the revision guard and the author guard exist, and no Listen In audio collection does
    expect(rules).toMatch(/request\.resource\.data\.revision >= resource\.data\.revision/);
    expect(rules).toMatch(/request\.resource\.data\.createdBy == request\.auth\.uid/);
    expect(rules).toMatch(/request\.resource\.data\.createdBy == resource\.data\.createdBy/);
    expect(rules).not.toMatch(/listenInAudio|listenInChunks/);
  });
});
