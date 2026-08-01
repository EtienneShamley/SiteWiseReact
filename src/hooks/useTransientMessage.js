// src/hooks/useTransientMessage.js
//
// One transient status message with a managed lifetime, shared by every editor
// surface that reports an image failure. The rules it follows are the pure
// model in src/lib/transientMessage.js; this hook owns only the timer:
//   - a new attempt clears the previous message immediately (call clear())
//   - a message auto-dismisses after TRANSIENT_MESSAGE_MS
//   - a repeated error restarts the countdown
//   - the timer is always cleared on unmount
//   - a superseded message's timer can never clear the current message
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MESSAGE_TONE,
  TRANSIENT_MESSAGE_MS,
  clearMessage,
  createMessageState,
  expireMessage,
  setMessage,
} from "../lib/transientMessage";

export default function useTransientMessage(ttlMs = TRANSIENT_MESSAGE_MS) {
  const [state, setState] = useState(createMessageState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const timerRef = useRef(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clear = useCallback(() => {
    stopTimer();
    const next = clearMessage(stateRef.current);
    if (next !== stateRef.current) {
      stateRef.current = next;
      setState(next);
    }
  }, [stopTimer]);

  const show = useCallback(
    (tone, message) => {
      stopTimer();
      const next = setMessage(stateRef.current, tone, message);
      stateRef.current = next;
      setState(next);
      if (!next.message) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const expired = expireMessage(stateRef.current, next.token);
        if (expired !== stateRef.current) {
          stateRef.current = expired;
          setState(expired);
        }
      }, ttlMs);
    },
    [stopTimer, ttlMs]
  );

  const showError = useCallback(
    (message) => show(MESSAGE_TONE.ERROR, message),
    [show]
  );
  const showInfo = useCallback(
    (message) => show(MESSAGE_TONE.INFO, message),
    [show]
  );

  useEffect(() => stopTimer, [stopTimer]);

  return {
    message: state.message,
    tone: state.tone,
    show,
    showError,
    showInfo,
    clear,
  };
}
