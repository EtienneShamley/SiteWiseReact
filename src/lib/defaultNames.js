// src/lib/defaultNames.js
//
// DEFAULT NAMES FOR NEW PROJECTS, FOLDERS AND NOTES — the pure allocator.
//
// A newly created project, folder or note is offered a canonical default
// name: "<Prefix> <n>". The rule for `n` is the LOWEST POSITIVE INTEGER not
// currently occupied by a canonical default name among the entity's current
// SIBLINGS — never max + 1, never a lifetime counter. Deleting "Folder 6"
// therefore makes 6 available again; deleting "Folder 2" out of 1..3 makes
// the next folder "Folder 2".
//
// Only a name that is EXACTLY "<Prefix> <n>" occupies a number: "Folder 2"
// does, "Folder 2 - Archive", "folder 2", "Folder 02", "Folder  2" and
// "Client Documents" do not. Renaming "Folder 2" to "Client Documents" frees
// 2; renaming something else to exactly "Folder 2" occupies it. Matching is
// plain string work, so a prefix can never be mistaken for a pattern.
//
// Nothing here is persisted: the names on screen ARE the state. Pure — no
// React, no storage.

/**
 * The number a name occupies for `prefix`, or null when the name is not a
 * canonical "<prefix> <n>" (n a positive integer with no leading zero).
 */
export function defaultNameNumber(prefix, name) {
  if (typeof prefix !== "string" || !prefix || typeof name !== "string") return null;
  const head = `${prefix} `;
  if (!name.startsWith(head)) return null;
  const digits = name.slice(head.length);
  if (!/^[1-9][0-9]*$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

/** The lowest positive integer no sibling's canonical name occupies. */
export function nextDefaultNumber(prefix, names) {
  const used = new Set();
  for (const name of Array.isArray(names) ? names : []) {
    const n = defaultNameNumber(prefix, name);
    if (n !== null) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

/** "<prefix> <n>" for the lowest free n among `names`. */
export function nextDefaultName(prefix, names) {
  return `${prefix} ${nextDefaultNumber(prefix, names)}`;
}
