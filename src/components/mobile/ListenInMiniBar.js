// src/components/mobile/ListenInMiniBar.js
//
// THE PERSISTENT LISTEN IN MINI-BAR (Phase 8E.1).
//
// Whenever an UNFINISHED meeting exists and Listen In is not the screen, the
// phone shell shows this compact bar directly above the bottom navigation, in
// the layout flow — never floating over the composer or the navigation.
//
//   recording     red, pulsing dot, "Recording", elapsed capture time
//   stopped       neutral, "Recording stopped · Meeting still open"
//   interrupted   amber, "Interrupted · Tap to resume or complete"
//   completing    neutral, "Completing meeting…"
//   completed     not shown
//
// Tapping it reopens THE SAME meeting: it calls the Listen In provider's
// `openWorkspace`, exactly as the desktop sidebar row does. It holds no
// recording, starts nothing, stops nothing and counts nothing itself — the
// elapsed time is derived from the session's own clock every second while
// capture is live, so it is identical to the Listen In screen's.
import React, { useEffect, useState } from "react";
import { FaMicrophone } from "react-icons/fa";
import { elapsedMs, formatElapsed } from "../../lib/listenIn/listenInModel";
import {
  LISTEN_IN_MINI_BAR,
  listenInMiniBarCopy,
  listenInMiniBarState,
} from "../../lib/mobileShell";

export default function ListenInMiniBar({ listenIn, onOpen, now = Date.now }) {
  const kind = listenInMiniBarState(listenIn);
  const recording = kind === LISTEN_IN_MINI_BAR.RECORDING;
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!recording) return undefined;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  if (!kind) return null;
  const capture = listenIn && listenIn.session ? listenIn.session : null;
  const elapsedLabel = capture ? formatElapsed(elapsedMs(capture, now())) : "";
  const copy = listenInMiniBarCopy(kind, { elapsedLabel });
  const showTime =
    !!elapsedLabel && (kind === LISTEN_IN_MINI_BAR.RECORDING || kind === LISTEN_IN_MINI_BAR.STOPPED);

  return (
    <div className="nw-phone-minibar-slot" data-nw-phone-minibar-slot>
      <button
        type="button"
        className={`nw-phone-minibar nw-phone-minibar--${kind}`}
        onClick={(event) => {
          if (typeof onOpen === "function") onOpen(event.currentTarget);
        }}
        aria-label={copy.accessibleLabel}
        data-listen-in-mini-bar={kind}
      >
        <span
          className={[
            "nw-phone-minibar__dot",
            recording ? "nw-listen-in-dot" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-hidden="true"
        />
        <FaMicrophone className="nw-phone-minibar__icon" aria-hidden="true" />
        <span className="nw-phone-minibar__text" aria-hidden="true">
          <span className="nw-phone-minibar__title">{copy.title}</span>
          {copy.detail && <span className="nw-phone-minibar__detail">{copy.detail}</span>}
        </span>
        {showTime && (
          <span className="nw-phone-minibar__time" aria-hidden="true">
            {elapsedLabel}
          </span>
        )}
        <span className="nw-phone-minibar__open" aria-hidden="true">
          Open
        </span>
      </button>
    </div>
  );
}
