// src/context/ShellLayoutContext.js
//
// WHICH SHELL COMPOSITION a shared component is rendered inside (Phase 8E.1).
//
// App.js decides it once, at the application boundary (src/lib/mobileShell.js
// → PHONE_SHELL_QUERY), and the phone shell provides PHONE to everything it
// renders. A shared component reads it only where the phone presentation must
// genuinely differ by policy — for example, the note workspace never mounts
// the full PDF editor inside the phone shell — never to restyle itself: phone
// presentation is the shell's composition and its CSS.
//
// The default is DESKTOP, so every component rendered outside the phone shell
// (the whole desktop application, and every existing test) behaves exactly as
// it did before this context existed.
import { createContext, useContext } from "react";

export const SHELL_LAYOUT = Object.freeze({
  DESKTOP: "desktop",
  PHONE: "phone",
});

export const ShellLayoutContext = createContext(SHELL_LAYOUT.DESKTOP);

export function useShellLayout() {
  return useContext(ShellLayoutContext);
}
