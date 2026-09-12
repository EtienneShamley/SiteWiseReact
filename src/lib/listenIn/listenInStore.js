// src/lib/listenIn/listenInStore.js
//
// WHERE A LISTEN IN SESSION LIVES — one interface, two implementations.
//
//   createListenInMemoryStore()    nothing outlives the tab. This is what the
//                                  currently APPROVED security policy allows,
//                                  and what a browser without IndexedDB gets.
//   createListenInDurableStore()   IndexedDB: the session survives a reload, a
//                                  crash and an hour offline. GATED by
//                                  src/lib/listenIn/listenInPolicy.js — see
//                                  that module for why this is not simply the
//                                  default.
//
// Both satisfy the SAME async contract, so the engine above them is written
// once and every behaviour is provable against both. The engine never learns
// which one it has; `survivesReload` is the single fact it may ask, and it
// uses that only to tell the user the truth.
//
//   putSession(session)                      upsert the header
//   getSession(uid, workspaceId, sessionId)
//   listSessions(uid, workspaceId)           headers only — never audio/text
//   putChunk(chunk, audio)                   seal one chunk (audio may be null)
//   patchChunk(uid, workspaceId, sessionId, seq, patch)
//   getChunkAudio(uid, workspaceId, sessionId, seq)
//   listChunks(uid, workspaceId, sessionId)  metadata + text, seq order, NO audio
//   releaseChunkAudio(uid, w, s, seq)        drop the bytes, keep the row
//   putSummary(summary)                      upsert the session's summary
//   getSummary(uid, workspaceId, sessionId)
//   deleteSession(uid, workspaceId, sessionId)
//
// EVERY OPERATION NAMES THE ACCOUNT. There is no call that reads, changes or
// deletes a Listen In record without an authenticated uid, and none that can
// be widened to "whatever is in this browser" by omitting one — an absent or
// blank uid is REFUSED, never treated as a wildcard.
//
// AUDIO IS NEVER RETURNED BY A LISTING. `listChunks` is what every view and
// the transcript derivation read, and it would otherwise pull an hour of
// speech into memory to render a sentence. Bytes come back only from
// `getChunkAudio`, which the drain calls for exactly one chunk at a time.
//
// IDENTITY SCOPING IS STRUCTURAL, not a filter. IndexedDB is scoped to the
// ORIGIN, not to a Firebase account: two people can sign into NoteWise in the
// same browser profile, and they may belong to the SAME workspace — so a
// workspace-only key would place one person's retained meeting audio squarely
// inside the other's range. Every key therefore begins `[uid, workspaceId, …]`
// (src/lib/assetDb.js), so a record cannot be addressed without naming the
// account that owns it. That is the same mechanism the asset layer uses for
// workspaces, one segment deeper.

import {
  LISTEN_IN_CHUNK_STORE,
  LISTEN_IN_SESSION_STORE,
  LISTEN_IN_SUMMARY_STORE,
  assetDbTransaction,
  listenInOwnerKeyRange,
  listenInSessionKeyRange,
} from "../assetDb";
import { sortBySeq } from "./listenInModel";

/** The audio field is stripped from anything a listing returns. */
function withoutAudio(row) {
  if (!row) return null;
  const { audio, ...rest } = row;
  return rest;
}

function requireIds(uid, workspaceId, sessionId) {
  if (typeof uid !== "string" || !uid) {
    throw new Error("A signed-in user is required to store a Listen In session");
  }
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new Error("A workspace is required to store a Listen In session");
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId)) {
    throw new Error("A session id is required to store a Listen In session");
  }
}

/* ============================== durable ================================== */

/**
 * The IndexedDB store. Only ever constructed once the durable-capture policy
 * is approved (src/lib/listenIn/listenInPolicy.js); constructing it does not
 * itself write anything.
 */
export function createListenInDurableStore() {
  return Object.freeze({
    survivesReload: true,

    async putSession(session) {
      requireIds(session.uid, session.workspaceId, session.sessionId);
      await assetDbTransaction(LISTEN_IN_SESSION_STORE, "readwrite", (stores) => {
        stores[LISTEN_IN_SESSION_STORE].put({ ...session });
      });
      return session;
    },

    async getSession(uid, workspaceId, sessionId) {
      requireIds(uid, workspaceId, sessionId);
      const row = await assetDbTransaction(LISTEN_IN_SESSION_STORE, "readonly", (stores) =>
        stores[LISTEN_IN_SESSION_STORE].get([uid, workspaceId, sessionId])
      );
      return row || null;
    },

    async listSessions(uid, workspaceId) {
      requireIds(uid, workspaceId);
      const rows = await assetDbTransaction(LISTEN_IN_SESSION_STORE, "readonly", (stores) =>
        stores[LISTEN_IN_SESSION_STORE].getAll(listenInOwnerKeyRange(uid, workspaceId))
      );
      // The range already excludes every other account; the filter is a second
      // statement of the same fact, not the mechanism.
      return (rows || []).filter((r) => r && r.uid === uid && r.workspaceId === workspaceId);
    },

    /**
     * Seal one chunk. The row and its bytes are written in ONE transaction, so
     * "this chunk exists" and "its audio is here" can never disagree — the
     * same invariant the asset layer's atomic creation keeps.
     */
    async putChunk(chunk, audio = null) {
      requireIds(chunk.uid, chunk.workspaceId, chunk.sessionId);
      await assetDbTransaction(LISTEN_IN_CHUNK_STORE, "readwrite", (stores) => {
        stores[LISTEN_IN_CHUNK_STORE].put({ ...chunk, audio: audio || null });
      });
      return chunk;
    },

    async patchChunk(uid, workspaceId, sessionId, seq, patch) {
      requireIds(uid, workspaceId, sessionId);
      return assetDbTransaction(LISTEN_IN_CHUNK_STORE, "readwrite", (stores) => {
        const store = stores[LISTEN_IN_CHUNK_STORE];
        const req = store.get([uid, workspaceId, sessionId, seq]);
        let updated = null;
        req.onsuccess = () => {
          const row = req.result;
          if (!row) return;
          // `releaseAudio` is how the caller asks for the bytes to go in the
          // same write that records why they may go.
          const { releaseAudio, ...fields } = patch || {};
          updated = { ...row, ...fields };
          if (releaseAudio) updated.audio = null;
          store.put(updated);
        };
        return () => withoutAudio(updated);
      });
    },

    async getChunkAudio(uid, workspaceId, sessionId, seq) {
      requireIds(uid, workspaceId, sessionId);
      const row = await assetDbTransaction(LISTEN_IN_CHUNK_STORE, "readonly", (stores) =>
        stores[LISTEN_IN_CHUNK_STORE].get([uid, workspaceId, sessionId, seq])
      );
      return row ? row.audio || null : null;
    },

    async listChunks(uid, workspaceId, sessionId) {
      requireIds(uid, workspaceId, sessionId);
      const rows = await assetDbTransaction(LISTEN_IN_CHUNK_STORE, "readonly", (stores) =>
        stores[LISTEN_IN_CHUNK_STORE].getAll(listenInSessionKeyRange(uid, workspaceId, sessionId))
      );
      return sortBySeq((rows || []).map(withoutAudio));
    },

    async releaseChunkAudio(uid, workspaceId, sessionId, seq) {
      return this.patchChunk(uid, workspaceId, sessionId, seq, { releaseAudio: true });
    },

    /**
     * The session's structured summary (Phase 8D.2). One row per session, in
     * its own store so a listing of headers never drags a meeting's summary
     * with it. Written by the engine's summary loop only; it holds derived
     * text, never audio.
     */
    async putSummary(summary) {
      requireIds(summary.uid, summary.workspaceId, summary.sessionId);
      await assetDbTransaction(LISTEN_IN_SUMMARY_STORE, "readwrite", (stores) => {
        stores[LISTEN_IN_SUMMARY_STORE].put({ ...summary });
      });
      return summary;
    },

    async getSummary(uid, workspaceId, sessionId) {
      requireIds(uid, workspaceId, sessionId);
      const row = await assetDbTransaction(LISTEN_IN_SUMMARY_STORE, "readonly", (stores) =>
        stores[LISTEN_IN_SUMMARY_STORE].get([uid, workspaceId, sessionId])
      );
      return row || null;
    },

    /** Everything: the header, every chunk row, every retained blob, the summary. */
    async deleteSession(uid, workspaceId, sessionId) {
      requireIds(uid, workspaceId, sessionId);
      await assetDbTransaction(
        [LISTEN_IN_SESSION_STORE, LISTEN_IN_CHUNK_STORE, LISTEN_IN_SUMMARY_STORE],
        "readwrite",
        (stores) => {
          stores[LISTEN_IN_SESSION_STORE].delete([uid, workspaceId, sessionId]);
          stores[LISTEN_IN_CHUNK_STORE].delete(listenInSessionKeyRange(uid, workspaceId, sessionId));
          stores[LISTEN_IN_SUMMARY_STORE].delete([uid, workspaceId, sessionId]);
        }
      );
    },
  });
}

/* ============================== memory =================================== */

/**
 * The same contract, held in this tab only. Not a test double: it is the
 * PRODUCTION store while the durable-capture policy is unapproved, and it is
 * what a browser with no IndexedDB gets either way. It therefore honours the
 * same rules — audio never leaves through a listing, keys are still
 * workspace-scoped — so nothing above it can quietly depend on durability.
 */
export function createListenInMemoryStore() {
  const sessions = new Map(); // "uid\u0000w\u0000s" → header
  const chunks = new Map(); // "uid\u0000w\u0000s\u0000seq" → row (audio included)
  const summaries = new Map(); // "uid\u0000w\u0000s" → the session's summary
  // The uid is part of the key here for the same reason it is part of the
  // IndexedDB key path: the boundary must hold in BOTH implementations, or the
  // durable tests would be proving a property the memory store does not have.
  const sessionKey = (u, w, s) => `${u}\u0000${w}\u0000${s}`;
  const chunkKey = (u, w, s, seq) => `${u}\u0000${w}\u0000${s}\u0000${seq}`;

  return Object.freeze({
    survivesReload: false,

    async putSession(session) {
      requireIds(session.uid, session.workspaceId, session.sessionId);
      sessions.set(sessionKey(session.uid, session.workspaceId, session.sessionId), {
        ...session,
      });
      return session;
    },

    async getSession(uid, workspaceId, sessionId) {
      requireIds(uid, workspaceId, sessionId);
      const row = sessions.get(sessionKey(uid, workspaceId, sessionId));
      return row ? { ...row } : null;
    },

    async listSessions(uid, workspaceId) {
      requireIds(uid, workspaceId);
      return [...sessions.values()]
        .filter((r) => r.uid === uid && r.workspaceId === workspaceId)
        .map((r) => ({ ...r }));
    },

    async putChunk(chunk, audio = null) {
      requireIds(chunk.uid, chunk.workspaceId, chunk.sessionId);
      chunks.set(chunkKey(chunk.uid, chunk.workspaceId, chunk.sessionId, chunk.seq), {
        ...chunk,
        audio: audio || null,
      });
      return chunk;
    },

    async patchChunk(uid, workspaceId, sessionId, seq, patch) {
      requireIds(uid, workspaceId, sessionId);
      const key = chunkKey(uid, workspaceId, sessionId, seq);
      const row = chunks.get(key);
      if (!row) return null;
      const { releaseAudio, ...fields } = patch || {};
      const updated = { ...row, ...fields };
      if (releaseAudio) updated.audio = null;
      chunks.set(key, updated);
      return withoutAudio(updated);
    },

    async getChunkAudio(uid, workspaceId, sessionId, seq) {
      requireIds(uid, workspaceId, sessionId);
      const row = chunks.get(chunkKey(uid, workspaceId, sessionId, seq));
      return row ? row.audio || null : null;
    },

    async listChunks(uid, workspaceId, sessionId) {
      requireIds(uid, workspaceId, sessionId);
      return sortBySeq(
        [...chunks.values()]
          .filter(
            (r) => r.uid === uid && r.workspaceId === workspaceId && r.sessionId === sessionId
          )
          .map(withoutAudio)
      );
    },

    async releaseChunkAudio(uid, workspaceId, sessionId, seq) {
      return this.patchChunk(uid, workspaceId, sessionId, seq, { releaseAudio: true });
    },

    async putSummary(summary) {
      requireIds(summary.uid, summary.workspaceId, summary.sessionId);
      summaries.set(sessionKey(summary.uid, summary.workspaceId, summary.sessionId), {
        ...summary,
      });
      return summary;
    },

    async getSummary(uid, workspaceId, sessionId) {
      requireIds(uid, workspaceId, sessionId);
      const row = summaries.get(sessionKey(uid, workspaceId, sessionId));
      return row ? { ...row } : null;
    },

    async deleteSession(uid, workspaceId, sessionId) {
      requireIds(uid, workspaceId, sessionId);
      sessions.delete(sessionKey(uid, workspaceId, sessionId));
      summaries.delete(sessionKey(uid, workspaceId, sessionId));
      for (const key of [...chunks.keys()]) {
        const row = chunks.get(key);
        if (row.uid === uid && row.workspaceId === workspaceId && row.sessionId === sessionId) {
          chunks.delete(key);
        }
      }
    },
  });
}
