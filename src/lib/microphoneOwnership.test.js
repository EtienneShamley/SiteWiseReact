// src/lib/microphoneOwnership.test.js
//
// One recorder at a time: the claim/release registry both voice workflows
// ask before opening a microphone stream (Phase 8C.1).
import {
  MICROPHONE_OWNER,
  claimMicrophone,
  currentMicrophoneOwner,
  releaseMicrophone,
  resetMicrophoneOwnershipForTests,
} from "./microphoneOwnership";

beforeEach(() => resetMicrophoneOwnershipForTests());

describe("claim and release", () => {
  test("a free microphone can be claimed by either workflow, and is then held", () => {
    expect(currentMicrophoneOwner()).toBeNull();
    expect(claimMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION)).toEqual({ ok: true });
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
  });

  test("the other workflow is refused and told who holds it; the holder is unaffected", () => {
    claimMicrophone(MICROPHONE_OWNER.LIVE_TRANSCRIPT);
    expect(claimMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION)).toEqual({
      ok: false,
      owner: MICROPHONE_OWNER.LIVE_TRANSCRIPT,
    });
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.LIVE_TRANSCRIPT);
  });

  test("re-claiming by the holder is idempotent", () => {
    claimMicrophone(MICROPHONE_OWNER.LIVE_TRANSCRIPT);
    expect(claimMicrophone(MICROPHONE_OWNER.LIVE_TRANSCRIPT)).toEqual({ ok: true });
  });

  test("only the holder can release; afterwards the other may claim", () => {
    claimMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
    expect(releaseMicrophone(MICROPHONE_OWNER.LIVE_TRANSCRIPT)).toBe(false);
    expect(currentMicrophoneOwner()).toBe(MICROPHONE_OWNER.QUICK_ADD_DICTATION);
    expect(releaseMicrophone(MICROPHONE_OWNER.QUICK_ADD_DICTATION)).toBe(true);
    expect(currentMicrophoneOwner()).toBeNull();
    expect(claimMicrophone(MICROPHONE_OWNER.LIVE_TRANSCRIPT)).toEqual({ ok: true });
  });

  test("releasing a free microphone is a harmless no-op; an invalid id never claims", () => {
    expect(releaseMicrophone(MICROPHONE_OWNER.LIVE_TRANSCRIPT)).toBe(false);
    expect(claimMicrophone("")).toEqual({ ok: false, owner: null });
    expect(claimMicrophone(undefined)).toEqual({ ok: false, owner: null });
    expect(currentMicrophoneOwner()).toBeNull();
  });
});
