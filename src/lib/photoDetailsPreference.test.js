// src/lib/photoDetailsPreference.test.js
//
// THE PHOTO-DETAILS PREFERENCE AND THE WORKSPACE'S PHOTO NUMBER (2026-09-07).
//
// Two facts this module exists to guarantee, both of which used to be wrong:
//
//   THE STAMP IS OPT-IN, for the camera as well as the `+` picker. A user who
//   has never touched the control gets clean photographs.
//   THE PHOTO NUMBER BELONGS TO A WORKSPACE, not to the browser. It is printed
//   into the pixels as documentary content, so one account's photographs must
//   never advance another's numbering — which is exactly what the retired
//   global `sitewise_photo_index` did.
//
// Both values ride the scope-following, non-durable helpers in
// durableStorage.js, so the scope switches here are the real mechanism, not a
// simulation of one.
import {
  DURABLE_SCOPE_KIND,
  __resetDurableStorageForTests,
  scopedStorageKey,
  setDurableScope,
} from "./durableStorage";
import {
  FIRST_PHOTO_NUMBER,
  LEGACY_GLOBAL_PHOTO_INDEX_KEY,
  PHOTO_DETAILS_DEFAULT,
  PHOTO_DETAILS_STORAGE_KEY,
  PHOTO_NUMBER_STORAGE_KEY,
  commitPhotoNumber,
  loadPhotoDetails,
  peekNextPhotoNumber,
  savePhotoDetails,
} from "./photoDetailsPreference";

const LOCAL = { kind: DURABLE_SCOPE_KIND.LOCAL };
const A = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-alice" };
const B = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-bob" };

beforeEach(() => {
  localStorage.clear();
  __resetDurableStorageForTests();
});

/** One stamped photograph in the ACTIVE scope: reserve, then commit. */
function stampOnePhoto() {
  const number = peekNextPhotoNumber();
  commitPhotoNumber(number);
  return number;
}

describe("the preference", () => {
  test("first use is OFF — for the camera too", () => {
    expect(PHOTO_DETAILS_DEFAULT).toBe(false);
    setDurableScope(A);
    expect(loadPhotoDetails()).toBe(false);
    // Reading it does not write it: a user who never touches the control has
    // nothing stored, so a later change of default would reach them.
    expect(localStorage.getItem(scopedStorageKey(PHOTO_DETAILS_STORAGE_KEY, A))).toBeNull();
  });

  test("an explicit choice is remembered, and can be turned back off", () => {
    setDurableScope(A);
    expect(savePhotoDetails(true)).toBe(true);
    expect(loadPhotoDetails()).toBe(true);
    expect(savePhotoDetails(false)).toBe(true);
    expect(loadPhotoDetails()).toBe(false);
  });

  test("anything that is not the stored ON marker reads as OFF", () => {
    setDurableScope(A);
    for (const junk of ["", "true", "yes", "2", "ON", "{}", "null"]) {
      localStorage.setItem(scopedStorageKey(PHOTO_DETAILS_STORAGE_KEY, A), junk);
      expect(loadPhotoDetails()).toBe(false);
    }
  });

  test("it does not leak between workspaces, and returns when the workspace does", () => {
    setDurableScope(A);
    savePhotoDetails(true);

    // B is a different account on the same browser: it sees its own default.
    setDurableScope(B);
    expect(loadPhotoDetails()).toBe(false);
    savePhotoDetails(false);

    // Signing back into A finds A's own choice, untouched by B.
    setDurableScope(A);
    expect(loadPhotoDetails()).toBe(true);
  });

  test("the pre-account (local) scope is separate from every workspace", () => {
    setDurableScope(LOCAL);
    savePhotoDetails(true);
    setDurableScope(A);
    expect(loadPhotoDetails()).toBe(false);
    setDurableScope(LOCAL);
    expect(loadPhotoDetails()).toBe(true);
  });

  test("a workspace's value is namespaced under that workspace", () => {
    setDurableScope(A);
    savePhotoDetails(true);
    expect(localStorage.getItem(`notewise-workspace-v1/ws-alice/${PHOTO_DETAILS_STORAGE_KEY}`)).toBe("1");
    // And NOT under the bare key, which belongs to the pre-account browser.
    expect(localStorage.getItem(PHOTO_DETAILS_STORAGE_KEY)).toBeNull();
  });

  test("storage that throws reads as the default and reports a failed write", () => {
    const hostile = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    };
    expect(loadPhotoDetails(hostile)).toBe(false);
    expect(savePhotoDetails(true, hostile)).toBe(false);
  });
});

describe("the workspace's photo number", () => {
  test("the first stamped photograph in a workspace is number 1", () => {
    setDurableScope(A);
    expect(peekNextPhotoNumber()).toBe(FIRST_PHOTO_NUMBER);
    expect(stampOnePhoto()).toBe(1);
    expect(peekNextPhotoNumber()).toBe(2);
  });

  test("A and B count independently, and returning to A resumes A's count", () => {
    setDurableScope(A);
    expect(stampOnePhoto()).toBe(1);
    expect(stampOnePhoto()).toBe(2);
    expect(stampOnePhoto()).toBe(3);

    // B is a different workspace: it starts at 1 and cannot inherit A's count.
    setDurableScope(B);
    expect(peekNextPhotoNumber()).toBe(1);
    expect(stampOnePhoto()).toBe(1);

    // Back in A, numbering continues where A left it — B's photograph did not
    // advance it, and A's did not advance B's.
    setDurableScope(A);
    expect(stampOnePhoto()).toBe(4);
    setDurableScope(B);
    expect(stampOnePhoto()).toBe(2);
  });

  test("sign-out and reopening the same workspace does not reset the count", () => {
    setDurableScope(A);
    stampOnePhoto();
    stampOnePhoto();

    // Sign-out returns the process to the pre-account scope and, in the real
    // application, clears the workspace MIRROR. The counter is a preference,
    // not workspace evidence, so it is deliberately not in that list.
    setDurableScope(LOCAL);
    expect(peekNextPhotoNumber()).toBe(1); // the browser's own, untouched by A

    setDurableScope(A);
    expect(peekNextPhotoNumber()).toBe(3);
  });

  test("a number is reserved without being consumed — a failed stamp leaves no gap", () => {
    setDurableScope(A);
    // The stamp draws this number into the pixels, then fails: no commit.
    expect(peekNextPhotoNumber()).toBe(1);
    expect(peekNextPhotoNumber()).toBe(1);
    expect(localStorage.getItem(scopedStorageKey(PHOTO_NUMBER_STORAGE_KEY, A))).toBeNull();

    // The next photograph that DOES produce bytes takes number 1.
    expect(stampOnePhoto()).toBe(1);
  });

  test("the counter only ever advances", () => {
    setDurableScope(A);
    stampOnePhoto();
    stampOnePhoto();
    // A slower concurrent stamp committing an older number must not hand
    // number 2 out twice: it is already printed on a stored photograph.
    expect(commitPhotoNumber(2)).toBe(false);
    expect(commitPhotoNumber(1)).toBe(false);
    expect(peekNextPhotoNumber()).toBe(3);
    expect(commitPhotoNumber(3)).toBe(true);
    expect(peekNextPhotoNumber()).toBe(4);
  });

  test("a malformed or hostile stored count reads as no photographs yet", () => {
    setDurableScope(A);
    for (const junk of ["", "abc", "-4", "1.5", "NaN", "1e400", "{}"]) {
      localStorage.setItem(scopedStorageKey(PHOTO_NUMBER_STORAGE_KEY, A), junk);
      expect(peekNextPhotoNumber()).toBe(1);
    }
  });

  test("a non-number is never committed", () => {
    setDurableScope(A);
    for (const junk of [0, -1, 1.5, NaN, Infinity, "3", null, undefined]) {
      expect(commitPhotoNumber(junk)).toBe(false);
    }
    expect(peekNextPhotoNumber()).toBe(1);
  });

  test("the retired browser-global counter is never read and never migrated", () => {
    // Its ownership is ambiguous — it counted every account that ever used
    // this browser — so adopting it into any one workspace would print a guess
    // onto evidence. It is left exactly where it is.
    localStorage.setItem(LEGACY_GLOBAL_PHOTO_INDEX_KEY, "417");
    setDurableScope(A);
    expect(peekNextPhotoNumber()).toBe(1);
    expect(stampOnePhoto()).toBe(1);
    expect(localStorage.getItem(LEGACY_GLOBAL_PHOTO_INDEX_KEY)).toBe("417");
  });

  test("the module names the legacy key so it cannot be reintroduced by accident", () => {
    expect(LEGACY_GLOBAL_PHOTO_INDEX_KEY).toBe("sitewise_photo_index");
    const source = require("fs").readFileSync(require("path").join(__dirname, "../components/BottomBar.js"), "utf8");
    // The composer no longer reaches for the global counter at all.
    expect(source).not.toMatch(/localStorage\.(get|set)Item\(\s*["']sitewise_photo_index["']/);
  });
});
