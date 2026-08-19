// src/components/template/BoundedNumberInput.js
//
// A bounded numeric field (percent, mm, px) for the Template Editor: a thin
// shell around the pure editing rule in src/lib/boundedNumberInput.js.
//
// It fixes the "cannot cleanly replace 0" defect of the former fully-controlled
// number fields: the text is LOCAL while the field has focus (so it can be
// emptied and retyped), a parseable value is applied live (clamped by the
// caller's model), and blur / Enter commits or reverts. The external value is
// re-shown only when the field is not focused, so the model clamping a partial
// value can never overwrite what is being typed. Escape reverts.

import React, { useEffect, useRef, useState } from "react";
import {
  boundedNumberText,
  commitBoundedNumber,
  liveBoundedNumber,
} from "../../lib/boundedNumberInput";

export default function BoundedNumberInput({
  id,
  value,
  limits,
  decimals = 1,
  step = 1,
  className = "",
  ariaLabel,
  disabled = false,
  onChange, // (number) => void — always finite and inside limits
}) {
  const [text, setText] = useState(() => boundedNumberText(value));
  const [focused, setFocused] = useState(false);
  const lastApplied = useRef(value);

  // Follow external changes (ribbon step, drag on the page, template reload)
  // only while the field is NOT being typed into.
  useEffect(() => {
    lastApplied.current = value;
    if (!focused) setText(boundedNumberText(value));
  }, [value, focused]);

  const apply = (n) => {
    if (n === null || n === undefined) return;
    if (n === lastApplied.current) return;
    lastApplied.current = n;
    if (onChange) onChange(n);
  };

  const commit = () => {
    const n = commitBoundedNumber(text, limits, lastApplied.current, decimals);
    setText(boundedNumberText(n));
    apply(n);
  };

  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      className={className}
      value={text}
      disabled={disabled}
      aria-label={ariaLabel}
      autoComplete="off"
      spellCheck={false}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        apply(liveBoundedNumber(next, limits, decimals));
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setText(boundedNumberText(lastApplied.current));
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const base = Number(lastApplied.current) || limits.min;
          const n = commitBoundedNumber(
            String(base + (e.key === "ArrowUp" ? step : -step)),
            limits,
            lastApplied.current,
            decimals
          );
          setText(boundedNumberText(n));
          apply(n);
        }
      }}
    />
  );
}
