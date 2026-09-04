// src/lib/dataScopeShell.test.js
//
// The Phase 6 shell, RENDERED over the in-memory workspace store: the
// workspace gate (resolving / error), the explicit migration step (its
// warning for data another account used, its run, its "Not now"), the
// Settings workspace and local-data sections, and the sign-out flush. Plus
// source-text assertions for the MainArea wiring that settles the autosave
// status on the account's answer rather than the local write.
import React, { useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";

jest.mock("./pdfMigration", () => ({ migrateLegacyNotePdfs: async () => ({ migrated: false }) }));
jest.mock("./templateMigration", () => ({
  runTemplateMigration: () => ({ status: "already-complete" }),
  TEMPLATE_MIGRATION_STATUS: { FAILED: "failed" },
}));
jest.mock("./templateLogoMigration", () => ({ migrateTemplateLogos: async () => {} }));
jest.mock("./noteAttachmentMigration", () => ({ migrateNoteAttachments: async () => {} }));

const { AuthProvider } = require("../context/AuthContext");
const { DataScopeProvider, useDataScope } = require("../context/DataScopeContext");
const { AppStateProvider, useAppState } = require("../context/AppStateContext");
const { ThemeProvider } = require("../context/ThemeContext");
const AuthGate = require("../components/auth/AuthGate").default;
const SettingsModal = require("../components/SettingsModal").default;
const { SIGN_OUT_LABEL, REMOVE_LOCAL_COPY_LABEL, MIGRATE_LOCAL_LABEL, syncStatusLine } = require("../components/SettingsModal");
const {
  MIGRATION_TITLE,
  MIGRATE_LABEL,
  MIGRATION_NOT_NOW_LABEL,
  MIGRATION_CONTINUE_LABEL,
  MIGRATION_AMBIGUOUS_TITLE,
  MIGRATION_RETRY_LABEL,
  migrationSummary,
} = require("../components/auth/LocalDataMigrationDialog");
const { WORKSPACE_LOADING_LABEL, WORKSPACE_ERROR_TITLE, WORKSPACE_ERROR_MESSAGE, workspaceErrorMessage } = require("../components/auth/WorkspaceGate");
const { DURABLE_KEYS, __resetDurableStorageForTests, getDurableScope } = require("./durableStorage");
const { __resetNoteTombstonesForTests } = require("./noteTombstones");
const { __resetApiAuthForTests } = require("./apiAuth");
const { createMemoryWorkspaceStore } = require("./cloud/memoryWorkspaceStore");
const { __resetCloudCaptureForTests } = require("./cloud/cloudCapture");
const { readLocalDataBinding, recordAccountSession } = require("./localDataBinding");
const { getNoteContent, saveNoteContent } = require("./noteContentStorage");
const { loadTree } = require("./treeStorage");
const { outboxSize } = require("./cloud/cloudOutbox");
const { SYNC_STATUS } = require("./cloud/cloudSync");

global.IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------ harness --------------------------------- */

function memoryAdapter(initialUser) {
  let current = initialUser || null;
  let listener = null;
  const calls = { signOut: 0 };
  const emit = () => listener && listener(current ? { ...current } : null);
  return {
    calls,
    subscribe(fn) {
      listener = fn;
      Promise.resolve().then(emit);
      return () => {
        listener = null;
      };
    },
    setUser(user) {
      current = user;
      emit();
    },
    async signIn() {
      throw new Error("not used");
    },
    async signUp() {
      throw new Error("not used");
    },
    async signOut() {
      calls.signOut += 1;
      current = null;
      emit();
    },
    async sendPasswordReset() {},
    async sendVerification() {
      return true;
    },
    async reload() {
      return current;
    },
    async getIdToken() {
      return current ? `token-${current.uid}` : null;
    },
  };
}

function storeFollowing(adapter) {
  const store = createMemoryWorkspaceStore();
  const originalSubscribe = adapter.subscribe.bind(adapter);
  adapter.subscribe = (fn) =>
    originalSubscribe((snapshot) => {
      store.setUser(snapshot ? snapshot.uid : null);
      fn(snapshot);
    });
  return store;
}

let isOnline = true;
const SESSION_OPTIONS = {
  syncOptions: { isOnline: () => isOnline, addOnlineListener: () => () => {}, setTimer: () => 0, clearTimer: () => {} },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
};

let root = null;
let container = null;
let latestScope = null;
let latestAppState = null;

function Probe() {
  const scope = useDataScope();
  const app = useAppState();
  useEffect(() => {
    latestScope = scope;
    latestAppState = app;
  });
  return <div>NW-APP-ROOT</div>;
}

function shell(adapter, store, { settings = false } = {}) {
  return (
    <ThemeProvider>
      <AuthProvider adapter={adapter}>
        <AuthGate>
          <DataScopeProvider store={store} sessionOptions={SESSION_OPTIONS}>
            <AppStateProvider>
              <Probe />
              {settings && <SettingsModal open onClose={() => {}} />}
            </AppStateProvider>
          </DataScopeProvider>
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  );
}

async function render(element) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await settle();
}

async function settle() {
  for (let i = 0; i < 15; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function unmount() {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  if (container) container.remove();
  root = null;
  container = null;
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const text = () => container.textContent;
const button = (label) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent.trim() === label) || null;
async function click(el) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

const USER = { uid: "uid-a", email: "a@example.com", emailVerified: true };

const SEED = {
  [DURABLE_KEYS.tree]: JSON.stringify({
    version: 1,
    projectData: [{ id: "p1", name: "Site A" }],
    folderMap: { p1: [{ id: "f1", name: "Day 1", notes: [{ id: "n1", title: "Borehole log" }] }] },
    rootFolders: [],
    rootFolderNotesMap: {},
    rootNotes: [],
  }),
  [DURABLE_KEYS.noteContent]: JSON.stringify({ n1: "<p>Borehole 14</p>" }),
};
function seed() {
  for (const [k, v] of Object.entries(SEED)) window.localStorage.setItem(k, v);
}
function seededValuesUnchanged() {
  for (const [k, v] of Object.entries(SEED)) expect(window.localStorage.getItem(k)).toBe(v);
}

beforeEach(() => {
  window.localStorage.clear();
  isOnline = true;
  __resetDurableStorageForTests();
  __resetCloudCaptureForTests();
  __resetApiAuthForTests();
  __resetNoteTombstonesForTests();
  latestScope = null;
  latestAppState = null;
  window.confirm = () => true;
});

afterEach(async () => {
  await unmount();
  __resetCloudCaptureForTests();
  __resetDurableStorageForTests();
});

/* ------------------------------ the gate -------------------------------- */

describe("workspace gate", () => {
  test("shows the resolving screen until the workspace is open, then the application in the authoritative scope", async () => {
    const adapter = memoryAdapter(USER);
    const store = storeFollowing(adapter);
    // hold the transaction back so the loading screen is observable
    let release = null;
    const original = store.runTransaction.bind(store);
    store.runTransaction = (fn) => new Promise((resolve, reject) => {
      release = () => original(fn).then(resolve, reject);
    });
    await render(shell(adapter, store));
    expect(text()).toContain(WORKSPACE_LOADING_LABEL);
    expect(text()).not.toContain("NW-APP-ROOT");
    expect(latestAppState).toBeNull();
    await act(async () => {
      release();
    });
    await settle();
    expect(text()).toContain("NW-APP-ROOT");
    expect(getDurableScope()).toEqual({ kind: "workspace", id: latestScope.workspace.id });
    expect(latestScope.mode).toBe("online");
  });

  test("a permission failure is one plain sentence with Retry and Sign out; nothing below mounts", async () => {
    const adapter = memoryAdapter(USER);
    const store = storeFollowing(adapter);
    store.failNext("transaction", "permission-denied");
    await render(shell(adapter, store));
    expect(text()).toContain(WORKSPACE_ERROR_TITLE);
    expect(text()).toContain(WORKSPACE_ERROR_MESSAGE["permission-denied"]);
    expect(text()).not.toMatch(/firestore|exception/i);
    expect(latestAppState).toBeNull();
    expect(workspaceErrorMessage({ code: "unavailable" })).toBe(WORKSPACE_ERROR_MESSAGE.offline);
    expect(workspaceErrorMessage(new Error("boom"))).toBe(WORKSPACE_ERROR_MESSAGE.unknown);
    await click(button("Sign out"));
    expect(adapter.calls.signOut).toBe(1);
  });
});

/* ---------------------------- the migration ----------------------------- */

describe("explicit local → cloud migration", () => {
  test("22/23/27/28. the step names what was found; Move imports it, marks complete only after the account accepted it, keeps the local copy", async () => {
    seed();
    const adapter = memoryAdapter(USER);
    const store = storeFollowing(adapter);
    await render(shell(adapter, store));
    expect(text()).toContain(MIGRATION_TITLE);
    expect(text()).toContain(migrationSummary({ projects: 1, folders: 1, notes: 1 }));
    expect(text()).not.toContain(MIGRATION_AMBIGUOUS_TITLE);
    expect(text()).not.toContain("NW-APP-ROOT");
    await click(button(MIGRATE_LABEL));
    expect(text()).toContain("Done");
    expect(readLocalDataBinding().migration.status).toBe("completed");
    seededValuesUnchanged();
    await click(button(MIGRATION_CONTINUE_LABEL));
    expect(text()).toContain("NW-APP-ROOT");
    expect(latestAppState.state.projectData).toEqual([{ id: "p1", name: "Site A" }]);
    expect(getNoteContent("n1")).toBe("<p>Borehole 14</p>");
    const workspaceId = latestScope.workspace.id;
    expect(store.get(["workspaces", workspaceId, "noteContent", "n1"]).html).toBe("<p>Borehole 14</p>");
    expect(Object.keys(store.listWorkspaceDocs(workspaceId, "nodes")).sort()).toEqual(["f1", "n1", "p1"]);
    expect(outboxSize(workspaceId)).toBe(0);
    expect(readLocalDataBinding().migration.workspaceId).toBe(workspaceId);
  });

  test("29. local data used by another account shows the warning and the count; Not now leaves everything as it is", async () => {
    seed();
    recordAccountSession("uid-someone-else");
    const adapter = memoryAdapter(USER);
    const store = storeFollowing(adapter);
    await render(shell(adapter, store));
    expect(text()).toContain(MIGRATION_AMBIGUOUS_TITLE);
    expect(text()).toContain("one other account has");
    await click(button(MIGRATION_NOT_NOW_LABEL));
    expect(text()).toContain("NW-APP-ROOT");
    expect(latestAppState.state.projectData).toEqual([]);
    expect(readLocalDataBinding().migration.status).toBe("not-started");
    seededValuesUnchanged();
  });

  test("25/26/27. offline: Move copies into this browser, stays 'in progress', is not marked complete; Retry once online completes it without duplicates", async () => {
    seed();
    isOnline = false;
    const adapter = memoryAdapter(USER);
    const store = storeFollowing(adapter);
    await render(shell(adapter, store));
    await click(button(MIGRATE_LABEL));
    expect(text()).toContain("waiting for a connection");
    expect(readLocalDataBinding().migration.status).toBe("in-progress");
    expect(button(MIGRATION_RETRY_LABEL)).not.toBeNull();
    seededValuesUnchanged();
    isOnline = true;
    await click(button(MIGRATION_RETRY_LABEL));
    expect(text()).toContain("Done");
    expect(readLocalDataBinding().migration.status).toBe("completed");
    await click(button(MIGRATION_CONTINUE_LABEL));
    const workspaceId = latestScope.workspace.id;
    expect(Object.keys(store.listWorkspaceDocs(workspaceId, "nodes"))).toHaveLength(3);
    expect(loadTree().projectData).toHaveLength(1);
  });

  test("once completed into this workspace the step is not offered again; Settings offers removal of the old copy", async () => {
    seed();
    const adapter = memoryAdapter(USER);
    const store = storeFollowing(adapter);
    await render(shell(adapter, store));
    await click(button(MIGRATE_LABEL));
    await click(button(MIGRATION_CONTINUE_LABEL));
    await unmount();

    await render(shell(adapter, store, { settings: true }));
    expect(text()).not.toContain(MIGRATION_TITLE);
    expect(text()).toContain("NW-APP-ROOT");
    expect(text()).toContain("backup");
    expect(button(MIGRATE_LOCAL_LABEL)).toBeNull();
    await click(button(REMOVE_LOCAL_COPY_LABEL));
    expect(window.localStorage.getItem(DURABLE_KEYS.noteContent)).toBeNull();
    expect(window.localStorage.getItem(DURABLE_KEYS.tree)).toBeNull();
    // the workspace mirror is unaffected
    expect(getNoteContent("n1")).toBe("<p>Borehole 14</p>");
    expect(text()).toContain("has been removed");
  });
});

/* ------------------------------ settings -------------------------------- */

describe("Settings", () => {
  test("shows the workspace sync state, offers the migration for un-moved local data, and flushes before sign-out", async () => {
    seed();
    const adapter = memoryAdapter(USER);
    const store = storeFollowing(adapter);
    await render(shell(adapter, store, { settings: true }));
    await click(button(MIGRATION_NOT_NOW_LABEL));
    expect(text()).toContain("Everything is saved to your account.");
    expect(button(MIGRATE_LOCAL_LABEL)).not.toBeNull();
    // Re-targeted in Phase 7.4: files are no longer stranded on one device —
    // the sentence now says what actually happens to them.
    expect(text()).toContain("Files");
    expect(text()).toContain("uploaded to it as well");
    expect(text()).toContain("uploading files to your account is not switched on in this version");
    expect(text()).not.toContain("until file sync arrives in a later update");
    expect(syncStatusLine({ status: SYNC_STATUS.OFFLINE, pending: 2 })).toMatch(/Offline — 2 changes/);
    expect(syncStatusLine({ status: SYNC_STATUS.ERROR, pending: 1, error: "permission-denied" })).toMatch(/not allowed/);

    // a queued edit is flushed by Sign out before the session ends
    const workspaceId = latestScope.workspace.id;
    saveNoteContent("late", "<p>typed just before sign-out</p>");
    expect(outboxSize(workspaceId)).toBe(1);
    await click(button(SIGN_OUT_LABEL));
    expect(adapter.calls.signOut).toBe(1);
    expect(store.get(["workspaces", workspaceId, "noteContent", "late"]).html).toBe("<p>typed just before sign-out</p>");
    expect(text()).not.toContain("NW-APP-ROOT");
  });
});

/* --------------------------- MainArea wiring ---------------------------- */

describe("MainArea autosave wiring (source text)", () => {
  const MAIN_AREA = fs.readFileSync(path.join(__dirname, "..", "components", "MainArea.js"), "utf8");
  const TOOLBAR = fs.readFileSync(path.join(__dirname, "..", "components", "EditorToolbar.js"), "utf8");

  test("42. a confirmed local write hands its sequence to the account's outcome; only a local FAILURE settles at once", () => {
    expect(MAIN_AREA).toMatch(/if \(ok && cloudSyncRef\.current\) awaitCloud\(CLOUD_COLLECTION\.NOTE_CONTENT, id, seq\);\s*else settleSaveRef\.current\(id, NOTE_VIEW\.FREEFORM, seq, ok\)/);
    expect(MAIN_AREA).toMatch(/if \(ok && cloudSyncRef\.current\) awaitCloud\(CLOUD_COLLECTION\.TEMPLATE_INSTANCES, targetNoteId, seq\)/);
    expect(MAIN_AREA).toMatch(/cloudSync\.subscribe\(\(event\) => \{\s*if \(event\.type !== "outcome"\) return;/);
    expect(MAIN_AREA).toMatch(/result\.outcome === SYNC_OUTCOME\.SYNCED\s*\? SAVE_OUTCOME\.SAVED\s*: result\.outcome === SYNC_OUTCOME\.QUEUED\s*\? SAVE_OUTCOME\.QUEUED\s*: SAVE_OUTCOME\.FAILED/);
  });

  test("a loaded note says 'Saved on this device' when a change is still queued; the toolbar shows the matching hint", () => {
    expect(MAIN_AREA).toMatch(/hasPending\(CLOUD_COLLECTION\.NOTE_CONTENT, noteKey\)/);
    expect(MAIN_AREA).toMatch(/hasPending\(CLOUD_COLLECTION\.TEMPLATE_INSTANCES, targetNoteId\)/);
    expect(MAIN_AREA).toMatch(/saveStatus=\{\{ label: activeSaveLabel, failed: activeSaveFailed, hint: activeSaveHint \}\}/);
    expect(TOOLBAR).toMatch(/const saveHint = saveStatus\?\.hint \|\| SAVED_HINT/);
    expect(TOOLBAR).not.toMatch(/Saved locally/);
  });

  test("46. sign-out asks every editor to flush its pending local writes first", () => {
    expect(MAIN_AREA).toMatch(/window\.addEventListener\(FLUSH_PENDING_WRITES_EVENT, flushFreeformWrites\)/);
    const SETTINGS = fs.readFileSync(path.join(__dirname, "..", "components", "SettingsModal.js"), "utf8");
    // Re-targeted in Phase 7.4: the preparation now also reports what the file
    // uploads could not finish, and its result is what sign-out reads.
    expect(SETTINGS).toMatch(/const prepared = scope \? await scope\.prepareSignOut\(\) : null;/);
    expect(SETTINGS).toMatch(/const result = await signOut\(\);/);
  });
});

// ---------------------------------------------------------------------------
// Production Readiness Phase 7.4 — the asset upload engine's wiring.
//
// The engine itself is tested directly (src/lib/cloud/assetUploadSync.test.js);
// what is asserted here is that it is BOUND to one session and stopped with
// it, that a build without a bucket still opens a working local-first session,
// and that sign-out gives the uploads a bounded chance and then says what is
// left.
describe("the asset upload engine's session binding (source)", () => {
  const SCOPE = fs.readFileSync(path.join(__dirname, "..", "context", "DataScopeContext.js"), "utf8");
  const SETTINGS = fs.readFileSync(path.join(__dirname, "..", "components", "SettingsModal.js"), "utf8");
  const MAIN = fs.readFileSync(path.join(__dirname, "..", "components", "MainArea.js"), "utf8");
  const APP_STATE = fs.readFileSync(path.join(__dirname, "..", "context", "AppStateContext.js"), "utf8");

  test("one engine per session, created with THAT session's workspace id", () => {
    expect(SCOPE).toMatch(/createAssetUploadSync\(\{\s*workspaceId: opened\.workspace\.id,/);
    expect(SCOPE).toMatch(/assetSyncRef\.current = uploads;/);
  });

  test("it is stopped synchronously when the session closes or the account changes", () => {
    expect(SCOPE).toMatch(/if \(uploads\) uploads\.stop\(\);/);
    expect(SCOPE).toMatch(/assetSyncRef\.current = null;/);
    expect(SCOPE).toMatch(/\[uid, attempt, injectedStore, injectedAssetStore, uploadOptions, sessionOptions\]/);
  });

  test("a missing bucket yields no store rather than an error, and no second cloud path", () => {
    expect(SCOPE).toMatch(/if \(!resolveFirebaseStorageConfig\(resolved\.config\)\.ok\) return null;/);
    expect(SCOPE).toMatch(/loadDefaultAssetStore\(\)\.catch\(\(\) => null\)/);
  });

  test("sign-out drains within the engine's bound deadline and reports the remainder", () => {
    expect(SCOPE).toMatch(/return \{ assets: await uploads\.drainForSignOut\(\) \};/);
    expect(SETTINGS).toMatch(/prepared\.assets \? prepared\.assets\.message : null/);
  });

  test("the toolbar reports uploads from the scope's engine, and BusyStatus keeps its local wording", () => {
    expect(MAIN).toMatch(/<AssetUploadStatus assetSync=\{dataScope \? dataScope\.assetSync : null\} \/>/);
    expect(MAIN).toMatch(/"Adding image…"/);
    expect(MAIN).toMatch(/"Adding file…"/);
    expect(MAIN).not.toMatch(/insertBusy === "image"\s*\? "Uploading/);
  });

  test("Settings offers Retry Now for the files that need attention", () => {
    expect(SETTINGS).toMatch(/scope\.assetSync\.retryNow\(\)/);
    expect(SETTINGS).toMatch(/assetSyncAttentionLine\(assetStatus\)/);
  });

  test("the PDF lifecycle enqueues only after the document is durable, and releases before the bytes go", () => {
    // Creation: the registry write and the state update come first.
    expect(APP_STATE).toMatch(/setPdfDocs\(\(prev\) => \(\{ \.\.\.prev, \[doc\.id\]: doc \}\)\);[\s\S]{0,600}?enqueuePdfSourceUpload\(sourceId/);
    // Replacement: the superseded source is released before the new one is owed.
    expect(APP_STATE).toMatch(/await releasePdfSourceUpload\(previousSourceId\)[\s\S]{0,200}?enqueuePdfSourceUpload\(nextSourceId/);
    // Deletion: released BEFORE the bytes are removed.
    expect(APP_STATE).toMatch(/await releasePdfSourceUpload\(pdfSourceId\(doc\)\)[\s\S]{0,300}?await removePdfBytes\(pdfSourceId\(doc\)\)/);
  });
});
