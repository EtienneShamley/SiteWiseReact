// src/lib/photoDetailsPreference.test.js
//
// THE PHOTO-DETAILS SETTING AND THE WORKSPACE'S PHOTO NUMBER (2026-09-08).
//
// Three facts this module exists to guarantee:
//
//   THE STAMP IS A WORKSPACE SETTING with three modes, defaulting to "camera
//   photos only": a camera capture is stamped, an uploaded photograph is not.
//   AN UPLOAD IS NEVER DESCRIBED BY THE DEVICE. Under "camera + uploaded
//   photos with original details" an upload may be stamped ONLY from its own
//   metadata, and only when it has a position of its own.
//   THE PHOTO NUMBER BELONGS TO A WORKSPACE, not to the browser. It is printed
//   into the pixels as documentary content, so one account's photographs must
//   never advance another's numbering.
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
  LEGACY_PHOTO_DETAILS_BOOLEAN_KEY,
  PHOTO_DETAILS_DEFAULT_MODE,
  PHOTO_DETAILS_MODE,
  PHOTO_DETAILS_MODES,
  PHOTO_DETAILS_STORAGE_KEY,
  PHOTO_NUMBER_STORAGE_KEY,
  PHOTO_ORIGIN,
  STAMP_POLICY,
  commitPhotoNumber,
  hasSufficientOriginalDetails,
  loadPhotoDetailsMode,
  normalizePhotoDetailsMode,
  peekNextPhotoNumber,
  savePhotoDetailsMode,
  stampPolicyFor,
} from "./photoDetailsPreference";

const LOCAL = { kind: DURABLE_SCOPE_KIND.LOCAL };
const A = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-alice" };
const B = { kind: DURABLE_SCOPE_KIND.WORKSPACE, id: "ws-bob" };
const { CAMERA_ONLY, CAMERA_AND_ORIGINAL, OFF } = PHOTO_DETAILS_MODE;

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

describe("the setting", () => {
  test("first use is CAMERA PHOTOS ONLY — and reading it writes nothing", () => {
    expect(PHOTO_DETAILS_DEFAULT_MODE).toBe(CAMERA_ONLY);
    expect(PHOTO_DETAILS_MODES).toEqual(["camera-only", "camera-and-original", "off"]);
    setDurableScope(A);
    expect(loadPhotoDetailsMode()).toBe(CAMERA_ONLY);
    // A user who never touches the control has nothing stored, so a later
    // change of default would still reach them.
    expect(localStorage.getItem(scopedStorageKey(PHOTO_DETAILS_STORAGE_KEY, A))).toBeNull();
  });

  test("an explicit choice is remembered, in each of the three modes", () => {
    setDurableScope(A);
    for (const mode of [CAMERA_AND_ORIGINAL, OFF, CAMERA_ONLY]) {
      expect(savePhotoDetailsMode(mode)).toBe(true);
      expect(loadPhotoDetailsMode()).toBe(mode);
    }
  });

  test("an unknown value is refused on write and reads as the default", () => {
    setDurableScope(A);
    for (const junk of ["", "true", "1", "camera", "CAMERA_ONLY", null, undefined, 3, {}]) {
      expect(savePhotoDetailsMode(junk)).toBe(false);
      expect(normalizePhotoDetailsMode(junk)).toBeNull();
    }
    for (const junk of ["", "true", "1", "0", "camera", "on", "{}"]) {
      localStorage.setItem(scopedStorageKey(PHOTO_DETAILS_STORAGE_KEY, A), junk);
      expect(loadPhotoDetailsMode()).toBe(CAMERA_ONLY);
    }
  });

  test("it does not leak between workspaces, and returns when the workspace does", () => {
    setDurableScope(A);
    savePhotoDetailsMode(OFF);

    // B is a different account on the same browser: it sees its own default.
    setDurableScope(B);
    expect(loadPhotoDetailsMode()).toBe(CAMERA_ONLY);
    savePhotoDetailsMode(CAMERA_AND_ORIGINAL);

    // Signing back into A finds A's own choice, untouched by B.
    setDurableScope(A);
    expect(loadPhotoDetailsMode()).toBe(OFF);
    setDurableScope(B);
    expect(loadPhotoDetailsMode()).toBe(CAMERA_AND_ORIGINAL);
  });

  test("the pre-account (local) scope is separate from every workspace", () => {
    setDurableScope(LOCAL);
    savePhotoDetailsMode(OFF);
    setDurableScope(A);
    expect(loadPhotoDetailsMode()).toBe(CAMERA_ONLY);
    setDurableScope(LOCAL);
    expect(loadPhotoDetailsMode()).toBe(OFF);
  });

  test("a workspace's value is namespaced under that workspace", () => {
    setDurableScope(A);
    savePhotoDetailsMode(OFF);
    expect(localStorage.getItem(`notewise-workspace-v1/ws-alice/${PHOTO_DETAILS_STORAGE_KEY}`)).toBe("off");
    expect(localStorage.getItem(PHOTO_DETAILS_STORAGE_KEY)).toBeNull();
  });

  test("storage that throws reads as the default and reports a failed write", () => {
    const hostile = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    };
    expect(loadPhotoDetailsMode(hostile)).toBe(CAMERA_ONLY);
    expect(savePhotoDetailsMode(OFF, hostile)).toBe(false);
  });
});

describe("migration from the one-day boolean", () => {
  const legacy = (scope, value) => localStorage.setItem(scopedStorageKey(LEGACY_PHOTO_DETAILS_BOOLEAN_KEY, scope), value);

  test("old explicit ON → camera photos only; old explicit OFF → off; nothing → camera photos only", () => {
    setDurableScope(A);
    legacy(A, "1");
    expect(loadPhotoDetailsMode()).toBe(CAMERA_ONLY);
    legacy(A, "0");
    expect(loadPhotoDetailsMode()).toBe(OFF);
    localStorage.removeItem(scopedStorageKey(LEGACY_PHOTO_DETAILS_BOOLEAN_KEY, A));
    expect(loadPhotoDetailsMode()).toBe(CAMERA_ONLY);
  });

  test("a stored mode wins over the legacy boolean, and reading migrates nothing", () => {
    setDurableScope(A);
    legacy(A, "1");
    savePhotoDetailsMode(OFF);
    expect(loadPhotoDetailsMode()).toBe(OFF);
    // The old key is left exactly as it was: read-through only.
    expect(localStorage.getItem(scopedStorageKey(LEGACY_PHOTO_DETAILS_BOOLEAN_KEY, A))).toBe("1");
    localStorage.removeItem(scopedStorageKey(PHOTO_DETAILS_STORAGE_KEY, A));
    legacy(A, "0");
    expect(loadPhotoDetailsMode()).toBe(OFF);
    expect(localStorage.getItem(scopedStorageKey(PHOTO_DETAILS_STORAGE_KEY, A))).toBeNull();
  });

  test("the legacy value is read in its OWN scope only — never across workspaces", () => {
    legacy(A, "0");
    setDurableScope(B);
    expect(loadPhotoDetailsMode()).toBe(CAMERA_ONLY);
    setDurableScope(LOCAL);
    expect(loadPhotoDetailsMode()).toBe(CAMERA_ONLY);
    setDurableScope(A);
    expect(loadPhotoDetailsMode()).toBe(OFF);
  });

  test("a legacy value that is neither marker is ignored", () => {
    setDurableScope(A);
    for (const junk of ["", "true", "on", "2"]) {
      legacy(A, junk);
      expect(loadPhotoDetailsMode()).toBe(CAMERA_ONLY);
    }
  });
});

describe("the policy each control gets", () => {
  test("camera photos only: the camera is DOCUMENTARY, an upload is not stamped", () => {
    expect(stampPolicyFor(CAMERA_ONLY, PHOTO_ORIGIN.CAMERA)).toBe(STAMP_POLICY.DOCUMENTARY);
    expect(stampPolicyFor(CAMERA_ONLY, PHOTO_ORIGIN.UPLOAD)).toBeNull();
  });

  test("camera + uploaded: the camera is DOCUMENTARY, an upload is ORIGINAL_ONLY", () => {
    expect(stampPolicyFor(CAMERA_AND_ORIGINAL, PHOTO_ORIGIN.CAMERA)).toBe(STAMP_POLICY.DOCUMENTARY);
    expect(stampPolicyFor(CAMERA_AND_ORIGINAL, PHOTO_ORIGIN.UPLOAD)).toBe(STAMP_POLICY.ORIGINAL_ONLY);
  });

  test("off: nothing is stamped from either control", () => {
    expect(stampPolicyFor(OFF, PHOTO_ORIGIN.CAMERA)).toBeNull();
    expect(stampPolicyFor(OFF, PHOTO_ORIGIN.UPLOAD)).toBeNull();
  });

  test("an upload is NEVER given the DOCUMENTARY policy, whatever the mode or the input", () => {
    for (const mode of [...PHOTO_DETAILS_MODES, "junk", null, undefined]) {
      expect(stampPolicyFor(mode, PHOTO_ORIGIN.UPLOAD)).not.toBe(STAMP_POLICY.DOCUMENTARY);
    }
    // An unknown origin gets nothing at all.
    expect(stampPolicyFor(CAMERA_AND_ORIGINAL, "clipboard")).toBeNull();
    expect(stampPolicyFor(CAMERA_AND_ORIGINAL, undefined)).toBeNull();
  });

  test("an unknown mode behaves as the default", () => {
    expect(stampPolicyFor("junk", PHOTO_ORIGIN.CAMERA)).toBe(STAMP_POLICY.DOCUMENTARY);
    expect(stampPolicyFor(undefined, PHOTO_ORIGIN.UPLOAD)).toBeNull();
  });
});

describe("what counts as enough original detail for an upload", () => {
  test("a valid original position is required — the date alone is not enough", () => {
    expect(hasSufficientOriginalDetails({ lat: -28.03, lon: 153.43, exifDate: null, altitude: null })).toBe(true);
    expect(hasSufficientOriginalDetails({ lat: -28.03, lon: 153.43, exifDate: new Date(), altitude: 14 })).toBe(true);
    expect(hasSufficientOriginalDetails({ lat: null, lon: null, exifDate: new Date(), altitude: 14 })).toBe(false);
    expect(hasSufficientOriginalDetails({ lat: -28.03, lon: null, exifDate: new Date(), altitude: null })).toBe(false);
  });

  test("a malformed position is not a position", () => {
    for (const bad of [
      { lat: NaN, lon: 153 },
      { lat: Infinity, lon: 153 },
      { lat: "-28", lon: "153" },
      { lat: 91, lon: 0 },
      { lat: 0, lon: 181 },
      null,
      undefined,
      {},
    ]) {
      expect(hasSufficientOriginalDetails(bad)).toBe(false);
    }
    // 0,0 is a real place, however unlikely.
    expect(hasSufficientOriginalDetails({ lat: 0, lon: 0 })).toBe(true);
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
