// src/hooks/useMediaQuery.js
//
// Whether a CSS media query currently matches, kept live through the browser's
// own `matchMedia` change events. Used by the application shell to compact the
// left sidebar to its icon rail on narrow viewports (App.js). Returns `false`
// wherever `matchMedia` does not exist (tests, very old browsers), so the shell
// degrades to its normal expanded layout rather than throwing.
import { useEffect, useState } from "react";

function matches(query) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export default function useMediaQuery(query) {
  const [matched, setMatched] = useState(() => matches(query));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    let list;
    try {
      list = window.matchMedia(query);
    } catch {
      return undefined;
    }
    const update = () => setMatched(!!list.matches);
    update();
    if (typeof list.addEventListener === "function") {
      list.addEventListener("change", update);
      return () => list.removeEventListener("change", update);
    }
    // Older Safari: the deprecated listener API.
    if (typeof list.addListener === "function") {
      list.addListener(update);
      return () => list.removeListener(update);
    }
    return undefined;
  }, [query]);

  return matched;
}
