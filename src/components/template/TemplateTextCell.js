// src/components/template/TemplateTextCell.js
//
// One Template Text answer, in one of two states:
//
//   inactive — a read-only React rendering of the stored answer
//   active   — the single Template rich-text editor (see TemplateRowEditor)
//
// Only the row the user is working in carries an editor. The two states share
// the same typography, padding and box model (`.twocol-rich`), so activating a
// row does not visibly resize it and cannot make pagination jump.

import React, { useRef } from "react";
import TemplateRichTextView from "./TemplateRichTextView";
import TemplateRowEditor from "./TemplateRowEditor";
import { answerToModel, isEmptyAnswerValue } from "../../lib/templateRichText";

export default function TemplateTextCell({
  // The complete editor identity for THIS row under the note's currently
  // assigned template and pinned version (null when this row is not the active
  // one). See templateRowEditorIdentity.
  identity,
  rowId,
  label,
  value,
  placeholder,
  active,
  reloadToken,
  onActivate,
  onChange,
  onRegisterEditor,
}) {
  // Where the caret should land once the editor exists. Set by the activation
  // that replaces this view, consumed once by the editor. The ref survives the
  // swap because this component instance does.
  const caretHintRef = useRef(null);

  const answerLabel = `${(label || "").trim() || "Answer"} — answer`;

  if (active && identity) {
    return (
      <TemplateRowEditor
        identity={identity}
        rowId={rowId}
        reloadToken={reloadToken}
        value={value}
        ariaLabel={answerLabel}
        caretHintRef={caretHintRef}
        onChange={onChange}
        onRegisterEditor={onRegisterEditor}
      />
    );
  }

  const handleMouseDown = (event) => {
    // The browser's own focus would land on this div a moment before it is
    // replaced. Taking the caret ourselves is both steadier and what lets the
    // editor open where the user actually clicked.
    event.preventDefault();
    // The hint is stamped with the identity this activation was aimed at, so a
    // template or version change in between cannot let it focus a different
    // editor. The identity is resolved by the parent at activation time.
    caretHintRef.current = {
      mode: "point",
      left: event.clientX,
      top: event.clientY,
      identity: onActivate(rowId) || null,
    };
  };

  const handleFocus = () => {
    const activated = onActivate(rowId) || null;
    if (!caretHintRef.current) {
      caretHintRef.current = { mode: "end", identity: activated };
    }
  };

  const empty = isEmptyAnswerValue(value);

  return (
    <div
      className="twocol-rich twocol-rich--static"
      tabIndex={0}
      role="textbox"
      aria-multiline="true"
      aria-label={answerLabel}
      onMouseDown={handleMouseDown}
      onFocus={handleFocus}
    >
      {empty ? (
        <span className="twocol-rich-placeholder">{placeholder}</span>
      ) : (
        <TemplateRichTextView model={answerToModel(value)} />
      )}
    </div>
  );
}
