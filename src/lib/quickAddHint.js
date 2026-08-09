// src/lib/quickAddHint.js
//
// The one-time contextual hint shown the first time a user targets a Template
// row with Quick Add.
//
// There is no toast or onboarding system in this codebase (docs/DESIGN_SYSTEM.md
// records a non-blocking notification pattern as PROPOSED, not implemented), and
// this feature is not the place to introduce one. So the hint reuses the
// existing restrained inline `role="status"` line with a managed lifetime
// (useTransientMessage) that image and file failures already use, and this
// module owns only the "has it been shown before" flag.
//
// PERSISTENCE AND LIFETIME, stated plainly:
//   - one boolean in localStorage, per browser profile
//   - written the first time the hint is actually shown
//   - it therefore appears ONCE, EVER, not once per session — the hint explains
//     a permanent interaction ("type directly, or use Quick Add"), and a user
//     who has learned it should not meet it again next week
//   - it is a UI preference, never user content, so losing it costs nothing:
//     a storage failure is swallowed and the hint simply shows again
//   - the Quick Add DESTINATION itself is deliberately NOT persisted anywhere
//     (see quickAddTarget.js); only this flag is
//
// Storage is injectable so the rules are testable without a browser.

const HINT_STORAGE_KEY = "notewise-quickadd-hint-seen-v1";

// The stored value is a flag, never content, so an exact-match check is enough
// and anything else counts as "not seen".
const SEEN_VALUE = "1";

function defaultStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Storage access itself can throw (disabled cookies, some privacy modes).
    return null;
  }
}

/**
 * The hint text. It names the row so the user connects it to what they just
 * clicked, and states BOTH options — direct editing is the primary path and
 * must not be hidden behind the new feature.
 */
export function quickAddHintMessage(rowLabel) {
  const name = (typeof rowLabel === "string" && rowLabel.trim()) || "That row";
  return `${name} selected — type directly in the field, or use Quick Add for voice, images and files.`;
}

export function hasSeenQuickAddHint(storage = defaultStorage()) {
  if (!storage) return false;
  try {
    return storage.getItem(HINT_STORAGE_KEY) === SEEN_VALUE;
  } catch {
    // Unreadable storage must not suppress the hint — showing it twice is a far
    // smaller cost than never showing it at all.
    return false;
  }
}

export function markQuickAddHintSeen(storage = defaultStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(HINT_STORAGE_KEY, SEEN_VALUE);
    return true;
  } catch {
    // A full or blocked quota is not worth reporting for a hint flag.
    return false;
  }
}

export { HINT_STORAGE_KEY as QUICK_ADD_HINT_STORAGE_KEY };
