// src/lib/authShell.test.js
//
// The authentication shell, RENDERED: AuthProvider (one subscription, mapped
// results), AuthGate (loading / unconfigured / signed-out / signed-in), the
// account screens (sign in, create account, reset, the fixed messages), the
// verification banner, the Settings account section, the data-scope context
// — and the promise that none of it touches this browser's local data.
//
// The auth provider is an in-memory adapter with the shape of
// src/lib/firebaseAuthAdapter.js; Firebase is never loaded.
import React, { useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

jest.mock("./pdfMigration", () => ({ migrateLegacyNotePdfs: async () => ({ migrated: false }) }));
jest.mock("./templateMigration", () => ({
  runTemplateMigration: () => ({ status: "already-complete" }),
  TEMPLATE_MIGRATION_STATUS: { FAILED: "failed" },
}));
jest.mock("./templateLogoMigration", () => ({ migrateTemplateLogos: async () => {} }));
jest.mock("./noteAttachmentMigration", () => ({ migrateNoteAttachments: async () => {} }));

const mockReadConfig = jest.fn();
jest.mock("./firebaseClientConfig", () => ({
  ...jest.requireActual("./firebaseClientConfig"),
  readFirebaseClientConfigFromEnv: () => mockReadConfig(),
}));

const { AuthProvider, useAuth } = require("../context/AuthContext");
const { DataScopeProvider, useDataScope } = require("../context/DataScopeContext");
const { AppStateProvider, useAppState } = require("../context/AppStateContext");
const { ThemeProvider } = require("../context/ThemeContext");
const AuthGate = require("../components/auth/AuthGate").default;
const { AUTH_LOADING_LABEL, AUTH_UNCONFIGURED_TITLE } = require("../components/auth/AuthGate");
const AuthScreen = require("../components/auth/AuthScreen").default;
const { AUTH_SCREEN_TITLE } = require("../components/auth/AuthScreen");
const { VERIFY_EMAIL_BANNER_TEXT } = require("../components/auth/VerifyEmailBanner");
const SettingsModal = require("../components/SettingsModal").default;
const { SIGN_OUT_LABEL } = require("../components/SettingsModal");
const { AUTH_MESSAGE, AUTH_NOTICE } = require("./authErrors");
const { AUTH_STATUS } = require("./authModel");
const { hasApiTokenProvider, authorizedFetch, __resetApiAuthForTests } = require("./apiAuth");
const { DURABLE_KEYS, __resetDurableStorageForTests } = require("./durableStorage");
const { LOCAL_DATA_BINDING_KEY, readLocalDataBinding } = require("./localDataBinding");
const { __resetNoteTombstonesForTests } = require("./noteTombstones");
const { createMemoryWorkspaceStore } = require("./cloud/memoryWorkspaceStore");
const { __resetCloudCaptureForTests } = require("./cloud/cloudCapture");
const { readWorkspaceBinding } = require("./cloud/workspaceBindingCache");
const { getNoteContent, saveNoteContent } = require("./noteContentStorage");
const { MIGRATION_TITLE, MIGRATION_NOT_NOW_LABEL } = require("../components/auth/LocalDataMigrationDialog");
const { WORKSPACE_ERROR_TITLE, WORKSPACE_RETRY_LABEL } = require("../components/auth/WorkspaceGate");

global.IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------ test adapter ---------------------------- */

const firebaseError = (code) => Object.assign(new Error(`Firebase: Error (${code}).`), { code });

function memoryAdapter({ initialUser = null, users = {} } = {}) {
  let current = initialUser;
  let listener = null;
  const accounts = { ...users }; // email → { password, verified }
  const calls = { sendVerification: 0, sendPasswordReset: [], signOut: 0, getIdToken: [] };
  const emit = () => listener && listener(current ? { ...current } : null);
  return {
    calls,
    accounts,
    subscribe(fn) {
      listener = fn;
      // Like the SDK: the persisted session is reported asynchronously.
      Promise.resolve().then(emit);
      return () => {
        listener = null;
      };
    },
    /** Test control: change the session out of band. */
    setUser(user) {
      current = user;
      emit();
    },
    async signIn(email, password) {
      const account = accounts[email];
      if (!account || account.password !== password) throw firebaseError("auth/invalid-credential");
      current = { uid: account.uid, email, emailVerified: account.verified === true };
      emit();
      return { ...current };
    },
    async signUp(email, password) {
      if (accounts[email]) throw firebaseError("auth/email-already-in-use");
      if (!/@/.test(email)) throw firebaseError("auth/invalid-email");
      if (password.length < 6) throw firebaseError("auth/weak-password");
      accounts[email] = { uid: `uid-${Object.keys(accounts).length + 1}`, password, verified: false };
      current = { uid: accounts[email].uid, email, emailVerified: false };
      emit();
      return { ...current };
    },
    async signOut() {
      calls.signOut += 1;
      current = null;
      emit();
    },
    async sendPasswordReset(email) {
      calls.sendPasswordReset.push(email);
      if (!accounts[email]) throw firebaseError("auth/user-not-found");
    },
    async sendVerification() {
      if (!current) return false;
      calls.sendVerification += 1;
      return true;
    },
    async reload() {
      if (!current) return null;
      const account = accounts[current.email];
      if (account) current = { ...current, emailVerified: account.verified === true };
      return { ...current };
    },
    async getIdToken(force) {
      calls.getIdToken.push(force);
      return current ? `token-for-${current.uid}${force ? "-fresh" : ""}` : null;
    },
  };
}

/* --------------------------------- render ------------------------------- */

let root = null;
let container = null;
let latestAuth = null;
let latestScope = null;
let latestAppState = null;

function AuthProbe() {
  const ctx = useAuth();
  useEffect(() => {
    latestAuth = ctx;
  });
  return null;
}
function ScopeProbe() {
  const ctx = useDataScope();
  useEffect(() => {
    latestScope = ctx;
  });
  return <div data-testid="app">NW-APP-ROOT</div>;
}
// A second consumer of the auth context, to prove consumers do not add
// subscriptions of their own.
function VerifyEmailBannerProbe() {
  useAuth();
  return null;
}
function AppStateProbe() {
  const ctx = useAppState();
  useEffect(() => {
    latestAppState = ctx;
  });
  return null;
}

async function render(element) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  // Let the adapter's asynchronous first report land.
  await act(async () => {
    await Promise.resolve();
  });
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
}

const text = () => container.textContent;
const byLabel = (label) => {
  const labelEl = Array.from(container.querySelectorAll("label")).find((l) => l.textContent.trim() === label);
  return labelEl ? document.getElementById(labelEl.getAttribute("for")) : null;
};
const button = (label) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent.trim() === label) || null;

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(el) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
async function submit() {
  await act(async () => {
    container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const VERIFIED_USER = { uid: "uid-v", email: "verified@example.com", emailVerified: true };
const USERS = {
  "verified@example.com": { uid: "uid-v", password: "correct-horse", verified: true },
  "new@example.com": { uid: "uid-n", password: "battery-staple", verified: false },
};

beforeEach(() => {
  window.localStorage.clear();
  __resetDurableStorageForTests();
  __resetCloudCaptureForTests();
  __resetApiAuthForTests();
  __resetNoteTombstonesForTests();
  mockReadConfig.mockReset();
  latestAuth = null;
  latestScope = null;
  latestAppState = null;
});

afterEach(async () => {
  await unmount();
  // the deferred session close
  await new Promise((resolve) => setTimeout(resolve, 5));
  __resetCloudCaptureForTests();
  __resetDurableStorageForTests();
});

/* ------------------------------- AuthGate ------------------------------- */

describe("AuthGate", () => {
  test("loading: neither the application nor the sign-in screen renders until the provider reports", async () => {
    const adapter = memoryAdapter();
    // Hold the first report back.
    adapter.subscribe = (fn) => {
      adapter.__emit = fn;
      return () => {};
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <AuthProvider adapter={adapter}>
          <AuthProbe />
          <AuthGate>
            <div data-testid="app">NW-APP-ROOT</div>
          </AuthGate>
        </AuthProvider>
      );
    });
    expect(latestAuth.status).toBe(AUTH_STATUS.LOADING);
    expect(text()).toContain(AUTH_LOADING_LABEL);
    expect(text()).not.toContain("NW-APP-ROOT");
    expect(text()).not.toContain(AUTH_SCREEN_TITLE["sign-in"]);
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    await act(async () => {
      adapter.__emit(null);
    });
    expect(latestAuth.status).toBe(AUTH_STATUS.SIGNED_OUT);
    expect(text()).toContain(AUTH_SCREEN_TITLE["sign-in"]);
    expect(text()).not.toContain("NW-APP-ROOT");
  });

  test("signed out → the sign-in screen; signed in → the application; a session change flips it", async () => {
    const adapter = memoryAdapter();
    await render(
      <AuthProvider adapter={adapter}>
        <AuthProbe />
        <AuthGate>
          <div data-testid="app">NW-APP-ROOT</div>
        </AuthGate>
      </AuthProvider>
    );
    expect(text()).toContain(AUTH_SCREEN_TITLE["sign-in"]);
    expect(text()).not.toContain("NW-APP-ROOT");

    await act(async () => adapter.setUser(VERIFIED_USER));
    expect(latestAuth.status).toBe(AUTH_STATUS.SIGNED_IN);
    expect(latestAuth.user).toEqual(VERIFIED_USER);
    expect(text()).toContain("NW-APP-ROOT");
    expect(text()).not.toContain(AUTH_SCREEN_TITLE["sign-in"]);
    expect(text()).not.toContain(VERIFY_EMAIL_BANNER_TEXT);

    await act(async () => adapter.setUser(null));
    expect(latestAuth.status).toBe(AUTH_STATUS.SIGNED_OUT);
    expect(text()).not.toContain("NW-APP-ROOT");
  });

  test("a signed-in but unverified user gets the application AND the verification reminder", async () => {
    const adapter = memoryAdapter({ initialUser: { uid: "u", email: "x@example.com", emailVerified: false } });
    await render(
      <AuthProvider adapter={adapter}>
        <AuthProbe />
        <AuthGate>
          <div>NW-APP-ROOT</div>
        </AuthGate>
      </AuthProvider>
    );
    expect(text()).toContain("NW-APP-ROOT");
    expect(text()).toContain(VERIFY_EMAIL_BANNER_TEXT);
    expect(latestAuth.canUseProviderFeatures).toBe(false);

    await click(button("Resend email"));
    expect(adapter.calls.sendVerification).toBe(1);
    expect(text()).toContain(AUTH_NOTICE.VERIFICATION_SENT);

    // "I've verified" re-reads the record; still unverified → says so.
    await click(button("I've verified"));
    expect(text()).toContain("not verified yet");
    // Verified out of band → the banner goes.
    adapter.accounts["x@example.com"] = { uid: "u", password: "p", verified: true };
    await click(button("I've verified"));
    expect(text()).not.toContain(VERIFY_EMAIL_BANNER_TEXT);
    expect(latestAuth.user.emailVerified).toBe(true);
    expect(latestAuth.canUseProviderFeatures).toBe(true);
  });

  test("an unconfigured build states the problem and never shows the application", async () => {
    mockReadConfig.mockReturnValue({ ok: false, missing: ["REACT_APP_FIREBASE_API_KEY", "REACT_APP_FIREBASE_APP_ID"] });
    await render(
      <AuthProvider>
        <AuthProbe />
        <AuthGate>
          <div>NW-APP-ROOT</div>
        </AuthGate>
      </AuthProvider>
    );
    expect(latestAuth.status).toBe(AUTH_STATUS.UNCONFIGURED);
    expect(text()).toContain(AUTH_UNCONFIGURED_TITLE);
    expect(text()).toContain("REACT_APP_FIREBASE_API_KEY");
    expect(text()).not.toContain("NW-APP-ROOT");
    expect(text()).not.toContain(AUTH_SCREEN_TITLE["sign-in"]);
  });

  test("exactly one subscription exists, and it is released on unmount together with the token provider", async () => {
    const adapter = memoryAdapter({ initialUser: VERIFIED_USER });
    const subscribe = jest.spyOn(adapter, "subscribe");
    await render(
      <ThemeProvider>
        <AuthProvider adapter={adapter}>
          <AuthGate>
            <AuthProbe />
            <SettingsModal open onClose={() => {}} />
            <VerifyEmailBannerProbe />
            <div>NW-APP-ROOT</div>
          </AuthGate>
        </AuthProvider>
      </ThemeProvider>
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(hasApiTokenProvider()).toBe(true);
    await unmount();
    expect(hasApiTokenProvider()).toBe(false);
  });
});

/* ------------------------------ AuthScreen ------------------------------ */

function screen(adapter) {
  return (
    <AuthProvider adapter={adapter}>
      <AuthProbe />
      <AuthGate>
        <div>NW-APP-ROOT</div>
      </AuthGate>
    </AuthProvider>
  );
}

describe("AuthScreen — sign in", () => {
  test("valid credentials sign the user in and the application appears", async () => {
    const adapter = memoryAdapter({ users: USERS });
    await render(screen(adapter));
    await type(byLabel("Email"), " verified@example.com ");
    await type(byLabel("Password"), "correct-horse");
    await submit();
    expect(latestAuth.status).toBe(AUTH_STATUS.SIGNED_IN);
    expect(text()).toContain("NW-APP-ROOT");
  });

  test("wrong password and unknown address show the SAME sentence — never the provider's", async () => {
    const adapter = memoryAdapter({ users: USERS });
    await render(screen(adapter));
    await type(byLabel("Email"), "verified@example.com");
    await type(byLabel("Password"), "wrong");
    await submit();
    const first = container.querySelector('[role="alert"]').textContent;
    expect(first).toBe(AUTH_MESSAGE.invalid_credentials);
    expect(text()).not.toMatch(/Firebase|auth\//);

    await type(byLabel("Email"), "nobody@example.com");
    await submit();
    expect(container.querySelector('[role="alert"]').textContent).toBe(first);
    expect(latestAuth.status).toBe(AUTH_STATUS.SIGNED_OUT);
  });

  test("an invalid email or empty password is refused before any provider call", async () => {
    const adapter = memoryAdapter({ users: USERS });
    const signIn = jest.spyOn(adapter, "signIn");
    await render(screen(adapter));
    await type(byLabel("Email"), "not an email");
    await type(byLabel("Password"), "x");
    await submit();
    expect(container.querySelector('[role="alert"]').textContent).toBe("Enter a valid email address.");
    await type(byLabel("Email"), "verified@example.com");
    await type(byLabel("Password"), "");
    await submit();
    expect(container.querySelector('[role="alert"]').textContent).toBe("Enter your password.");
    expect(signIn).not.toHaveBeenCalled();
  });

  test("the form offers Forgot password? and Create an account", async () => {
    await render(screen(memoryAdapter()));
    expect(button("Forgot password?")).not.toBeNull();
    expect(button("Create an account")).not.toBeNull();
    expect(byLabel("Email").getAttribute("type")).toBe("email");
    expect(byLabel("Password").getAttribute("type")).toBe("password");
    expect(byLabel("Password").getAttribute("autocomplete")).toBe("current-password");
  });
});

describe("AuthScreen — create account", () => {
  async function openSignUp(adapter) {
    await render(screen(adapter));
    await click(button("Create an account"));
    expect(text()).toContain(AUTH_SCREEN_TITLE["sign-up"]);
  }

  test("a valid sign-up creates the account, signs in, sends the verification email and shows the reminder", async () => {
    const adapter = memoryAdapter({ users: USERS });
    await openSignUp(adapter);
    await type(byLabel("Email"), "fresh@example.com");
    await type(byLabel("Password"), "eightchars");
    await type(byLabel("Confirm password"), "eightchars");
    await submit();
    expect(latestAuth.status).toBe(AUTH_STATUS.SIGNED_IN);
    expect(latestAuth.user.email).toBe("fresh@example.com");
    expect(latestAuth.user.emailVerified).toBe(false);
    expect(adapter.calls.sendVerification).toBe(1);
    expect(text()).toContain("NW-APP-ROOT");
    expect(text()).toContain(VERIFY_EMAIL_BANNER_TEXT);
  });

  test("weak password, mismatch and invalid email are refused before the provider", async () => {
    const adapter = memoryAdapter({ users: USERS });
    const signUp = jest.spyOn(adapter, "signUp");
    await openSignUp(adapter);
    await type(byLabel("Email"), "fresh@example.com");
    await type(byLabel("Password"), "short");
    await type(byLabel("Confirm password"), "short");
    await submit();
    expect(container.querySelector('[role="alert"]').textContent).toBe("Use at least 8 characters for your password.");
    await type(byLabel("Password"), "longenough1");
    await type(byLabel("Confirm password"), "longenough2");
    await submit();
    expect(container.querySelector('[role="alert"]').textContent).toBe("The passwords do not match.");
    await type(byLabel("Email"), "nope");
    await type(byLabel("Confirm password"), "longenough1");
    await submit();
    expect(container.querySelector('[role="alert"]').textContent).toBe("Enter a valid email address.");
    expect(signUp).not.toHaveBeenCalled();
    expect(latestAuth.status).toBe(AUTH_STATUS.SIGNED_OUT);
  });

  test("a duplicate account is reported with our sentence, and the provider's weak-password refusal is mapped too", async () => {
    const adapter = memoryAdapter({ users: USERS });
    await openSignUp(adapter);
    await type(byLabel("Email"), "verified@example.com");
    await type(byLabel("Password"), "eightchars");
    await type(byLabel("Confirm password"), "eightchars");
    await submit();
    expect(container.querySelector('[role="alert"]').textContent).toBe(AUTH_MESSAGE.email_in_use);
    expect(latestAuth.status).toBe(AUTH_STATUS.SIGNED_OUT);

    // The provider is the final arbiter of password strength: simulate its
    // refusal of a password our pre-check allowed.
    adapter.signUp = async () => {
      throw firebaseError("auth/weak-password");
    };
    await type(byLabel("Email"), "another@example.com");
    await submit();
    expect(container.querySelector('[role="alert"]').textContent).toBe(AUTH_MESSAGE.weak_password);
  });

  test("a network failure during sign-up is one plain sentence", async () => {
    const adapter = memoryAdapter();
    adapter.signUp = async () => {
      throw firebaseError("auth/network-request-failed");
    };
    await openSignUp(adapter);
    await type(byLabel("Email"), "x@example.com");
    await type(byLabel("Password"), "eightchars");
    await type(byLabel("Confirm password"), "eightchars");
    await submit();
    expect(container.querySelector('[role="alert"]').textContent).toBe(AUTH_MESSAGE.network);
  });
});

describe("AuthScreen — password reset", () => {
  test("a known and an unknown address get the same neutral confirmation; a real failure is reported", async () => {
    const adapter = memoryAdapter({ users: USERS });
    await render(screen(adapter));
    await click(button("Forgot password?"));
    expect(text()).toContain(AUTH_SCREEN_TITLE.reset);
    expect(byLabel("Password")).toBeNull();

    await type(byLabel("Email"), "verified@example.com");
    await submit();
    expect(container.querySelector('[role="status"]').textContent).toBe(AUTH_NOTICE.RESET_SENT);
    await type(byLabel("Email"), "unknown@example.com");
    await submit();
    expect(container.querySelector('[role="status"]').textContent).toBe(AUTH_NOTICE.RESET_SENT);
    expect(adapter.calls.sendPasswordReset).toEqual(["verified@example.com", "unknown@example.com"]);

    adapter.sendPasswordReset = async () => {
      throw firebaseError("auth/too-many-requests");
    };
    await submit();
    expect(container.querySelector('[role="alert"]').textContent).toBe(AUTH_MESSAGE.too_many_requests);

    await click(button("Back to sign in"));
    expect(text()).toContain(AUTH_SCREEN_TITLE["sign-in"]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

/* --------------------------- Settings + sign out ------------------------ */

describe("Settings account section", () => {
  test("shows the email and verification state, and Sign out ends the session", async () => {
    const adapter = memoryAdapter({ initialUser: VERIFIED_USER });
    await render(
      <ThemeProvider>
        <AuthProvider adapter={adapter}>
          <AuthProbe />
          <AuthGate>
            <SettingsModal open onClose={() => {}} />
            <div>NW-APP-ROOT</div>
          </AuthGate>
        </AuthProvider>
      </ThemeProvider>
    );
    expect(text()).toContain("verified@example.com");
    expect(text()).toContain("Email verified");
    expect(text()).toContain("saved to your account");
    await click(button(SIGN_OUT_LABEL));
    expect(adapter.calls.signOut).toBe(1);
    expect(latestAuth.status).toBe(AUTH_STATUS.SIGNED_OUT);
    expect(text()).not.toContain("NW-APP-ROOT");
    expect(text()).toContain(AUTH_SCREEN_TITLE["sign-in"]);
  });

  test("offers no account-deletion control", async () => {
    const adapter = memoryAdapter({ initialUser: VERIFIED_USER });
    await render(
      <ThemeProvider>
        <AuthProvider adapter={adapter}>
          <AuthGate>
            <SettingsModal open onClose={() => {}} />
          </AuthGate>
        </AuthProvider>
      </ThemeProvider>
    );
    expect(text()).not.toMatch(/delete (my )?account|delete account/i);
  });
});

/* --------------------------- tokens for the API ------------------------- */

describe("identity for backend calls", () => {
  test("a signed-in session supplies the token to the API boundary; signed out supplies none", async () => {
    const adapter = memoryAdapter({ initialUser: VERIFIED_USER });
    await render(screen(adapter));
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await authorizedFetch("/api/refine", { method: "POST" }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer token-for-uid-v");
    expect(adapter.calls.getIdToken).toEqual([false]);

    await act(async () => adapter.setUser(null));
    await expect(authorizedFetch("/api/refine", {}, { fetchImpl })).rejects.toMatchObject({ outcome: "unauthenticated" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("no token is ever written to browser storage", async () => {
    const adapter = memoryAdapter({ initialUser: VERIFIED_USER });
    await render(screen(adapter));
    await authorizedFetch("/api/refine", {}, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    const all = JSON.stringify(window.localStorage) + JSON.stringify(window.sessionStorage);
    expect(all).not.toContain("token-for");
  });
});

/* ------------------------- data scope + local data ---------------------- */

const SEED = {
  [DURABLE_KEYS.tree]: JSON.stringify({
    version: 1,
    projectData: [{ id: "p1", name: "Site A" }],
    folderMap: { p1: [{ id: "f1", name: "Day 1", notes: [{ id: "n1", title: "Borehole log" }] }] },
    rootFolders: [],
    rootFolderNotesMap: {},
    rootNotes: [],
  }),
  [DURABLE_KEYS.noteContent]: JSON.stringify({ n1: "<p>Borehole 14: silty CLAY, moist, firm.</p>" }),
  [DURABLE_KEYS.templates]: JSON.stringify({ t1: { id: "t1", name: "Daily diary", createdAt: 1, updatedAt: 1, currentVersionId: "v1" } }),
  [DURABLE_KEYS.templateInstances]: JSON.stringify({ n1: { noteId: "n1", templateId: "t1", templateVersionId: "v1", answers: { a: "1" } } }),
};

function seed() {
  for (const [k, v] of Object.entries(SEED)) window.localStorage.setItem(k, v);
}
function seededValuesUnchanged() {
  for (const [k, v] of Object.entries(SEED)) expect(window.localStorage.getItem(k)).toBe(v);
}

// Phase 6: the data scope resolves a CLOUD workspace through the store. The
// in-memory store stands in for Firestore; the session options keep the sync
// engine synchronous. A signed-in session with local data present lands on
// the explicit migration step; "Not now" opens the workspace.
const SESSION_OPTIONS = {
  syncOptions: { isOnline: () => true, addOnlineListener: () => () => {}, setTimer: () => 0, clearTimer: () => {} },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
};

function fullShell(adapter, store) {
  return (
    <AuthProvider adapter={adapter}>
      <AuthProbe />
      <AuthGate>
        <DataScopeProvider store={store} sessionOptions={SESSION_OPTIONS}>
          <AppStateProvider>
            <AppStateProbe />
            <ScopeProbe />
          </AppStateProvider>
        </DataScopeProvider>
      </AuthGate>
    </AuthProvider>
  );
}

// The store follows the auth adapter's session like the Firestore SDK does.
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

async function settle() {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("data scope and existing local data", () => {
  test("signed out: the application state provider is not mounted and local records are untouched", async () => {
    seed();
    const adapter = memoryAdapter();
    await render(fullShell(adapter, storeFollowing(adapter)));
    expect(latestAppState).toBeNull();
    expect(latestScope).toBeNull();
    seededValuesUnchanged();
    expect(window.localStorage.getItem(LOCAL_DATA_BINDING_KEY)).toBeNull();
  });

  test("21. signing in resolves a cloud workspace, records the account, and OFFERS — never performs — the migration of local data", async () => {
    seed();
    const adapter = memoryAdapter({ users: USERS });
    const store = storeFollowing(adapter);
    await render(fullShell(adapter, store));
    await act(async () => {
      await adapter.signIn("verified@example.com", "correct-horse");
    });
    await settle();
    // the explicit step, not the application
    expect(text()).toContain(MIGRATION_TITLE);
    expect(text()).not.toContain("NW-APP-ROOT");
    expect(Object.keys(store.listWorkspaceDocs(store.getUser() && readWorkspaceBinding("uid-v").workspaceId, "noteContent"))).toEqual([]);
    seededValuesUnchanged();
    const binding = readLocalDataBinding();
    expect(binding.firstUid).toBe("uid-v");
    expect(binding.migration.status).toBe("not-started");

    // "Not now" opens the workspace with the real, authoritative scope
    await click(button(MIGRATION_NOT_NOW_LABEL));
    await settle();
    expect(text()).toContain("NW-APP-ROOT");
    expect(latestScope.uid).toBe("uid-v");
    expect(latestScope.emailVerified).toBe(true);
    expect(latestScope.workspace.kind).toBe("cloud");
    expect(latestScope.workspace.id).toBe(readWorkspaceBinding("uid-v").workspaceId);
    expect(latestScope.workspace.role).toBe("owner");
    expect(Object.isFrozen(latestScope)).toBe(true);
    // the workspace is EMPTY: the browser's local tree was not adopted
    expect(latestAppState.state.projectData).toEqual([]);
    seededValuesUnchanged();
  });

  test("7. no fake identity: the scope carries the real uid and a workspace the store actually resolved", async () => {
    const adapter = memoryAdapter({ initialUser: { uid: "real-firebase-uid", email: "a@b.co", emailVerified: false } });
    const store = storeFollowing(adapter);
    await render(fullShell(adapter, store));
    await settle();
    expect(latestScope.uid).toBe("real-firebase-uid");
    expect(latestScope.workspace.id).toMatch(/^ws-/);
    expect(store.get(["workspaces", latestScope.workspace.id, "members", "real-firebase-uid"]).role).toBe("owner");
    expect(latestScope.emailVerified).toBe(false);
  });

  test("8/9/32/33. signing out clears the scope; another account on the same browser resolves ITS OWN workspace and sees none of the first's data", async () => {
    const adapter = memoryAdapter({ initialUser: VERIFIED_USER });
    const store = storeFollowing(adapter);
    await render(fullShell(adapter, store));
    await settle();
    const first = latestScope.workspace.id;
    expect(text()).toContain("NW-APP-ROOT");
    // A writes a note in A's workspace
    saveNoteContent("a-note", "<p>Alice's field note</p>");
    await act(async () => {
      await latestScope.sync.flush();
    });
    expect(store.get(["workspaces", first, "noteContent", "a-note"]).html).toBe("<p>Alice's field note</p>");

    await act(async () => {
      await adapter.signOut();
    });
    await settle();
    expect(text()).not.toContain("NW-APP-ROOT");
    latestScope = null;
    latestAppState = null;

    await act(async () => adapter.setUser({ uid: "uid-other", email: "other@example.com", emailVerified: true }));
    await settle();
    expect(latestScope.uid).toBe("uid-other");
    expect(latestScope.workspace.id).not.toBe(first);
    expect(getNoteContent("a-note")).toBeNull();
    expect(latestAppState.state.projectData).toEqual([]);

    // and A, back again, finds A's workspace and A's note
    await act(async () => adapter.setUser(null));
    await settle();
    await act(async () => adapter.setUser(VERIFIED_USER));
    await settle();
    expect(latestScope.workspace.id).toBe(first);
    expect(getNoteContent("a-note")).toBe("<p>Alice's field note</p>");
  });

  test("sign-up does not upload or mutate local content", async () => {
    seed();
    const adapter = memoryAdapter();
    const store = storeFollowing(adapter);
    await render(fullShell(adapter, store));
    await act(async () => {
      await adapter.signUp("brand-new@example.com", "eightchars");
    });
    await settle();
    expect(text()).toContain(MIGRATION_TITLE);
    seededValuesUnchanged();
    const wid = readWorkspaceBinding("uid-1").workspaceId;
    expect(Object.keys(store.listWorkspaceDocs(wid, "noteContent"))).toEqual([]);
    expect(Object.keys(store.listWorkspaceDocs(wid, "nodes"))).toEqual([]);
    // Nothing left the browser through the API boundary: no token request.
    expect(adapter.calls.getIdToken).toEqual([]);
  });

  test("the workspace cannot be resolved (no cloud, no cached copy): an error screen, never local data, never the application", async () => {
    seed();
    const adapter = memoryAdapter({ initialUser: VERIFIED_USER });
    const store = storeFollowing(adapter);
    store.failNext("transaction", "unavailable");
    await render(fullShell(adapter, store));
    await settle();
    expect(text()).toContain(WORKSPACE_ERROR_TITLE);
    expect(text()).not.toContain("NW-APP-ROOT");
    expect(latestAppState).toBeNull();
    seededValuesUnchanged();
    // Retry resolves once the cloud answers
    await click(button(WORKSPACE_RETRY_LABEL));
    await settle();
    expect(text()).toContain(MIGRATION_TITLE);
  });
});
