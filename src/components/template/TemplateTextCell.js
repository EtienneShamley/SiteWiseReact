// src/components/template/TemplateTextCell.js
//
// One Template TEXT target, in one of two states:
//
//   inactive — a read-only React rendering of the stored value
//   active   — the single Template rich-text editor (see TemplateRowEditor)
//
// The target is either a row's legacy Text answer or ONE ordered section text
// item inside a row (src/lib/templateSectionContent.js). Both are the same kind
// of thing — an answer value the user types into — so both use this one cell
// rather than a second rich-text implementation. Which stored slot a committed
// change lands in is decided by the parent from the editor identity it handed
// down, never by this component.
//
// Only the target the user is working in carries an editor. The two states
// share the same typography, padding and box model (`.twocol-rich`), so
// activating one does not visibly resize it and cannot make pagination jump.

import React, { useRef } from "react";
import TemplateRichTextView from "./TemplateRichTextView";
import TemplateRowEditor from "./TemplateRowEditor";
import { answerToModel, isEmptyAnswerValue } from "../../lib/templateRichText";

export default function TemplateTextCell({
  // The complete editor identity for THIS target under the note's currently
  // assigned template and pinned version (null when it is not the active one).
  // See templateRowEditorIdentity.
  identity,
  rowId,
  // The ordered section text item this cell edits, when it edits one. Null for
  // a row's legacy Text answer. It is passed back on activation so the parent
  // can address the item; it is NEVER a Quick Add destination — the row is.
  itemId = null,
  label,
  value,
  placeholder,
  // Overrides the label-derived accessible name. A section holding several text
  // items needs each one named distinctly, or they all read as "Label — answer".
  ariaLabel,
  active,
  // This cell is created ALREADY ACTIVE — it is the leading insertion point a
  // user clicked above a section's first image, so there was no static view to
  // have recorded where the caret should go. It seeds its own caret hint, or
  // the click would produce an editor the user cannot type into.
  focusOnActivate = false,
  reloadToken,
  onActivate,
  onChange,
  onRegisterEditor,
}) {
  // Where the caret should land once the editor exists. Set by the activation
  // that replaces this view, consumed once by the editor. The ref survives the
  // swap because this component instance does.
  const caretHintRef = useRef(null);
  // Seeded at most ONCE per mounted cell: a later editor recreation (a
  // programmatic content replacement) must not steal focus back.
  const seededCaretRef = useRef(false);
  if (focusOnActivate && active && identity && !seededCaretRef.current) {
    seededCaretRef.current = true;
    if (!caretHintRef.current) caretHintRef.current = { mode: "end", identity };
  }

  const answerLabel =
    (ariaLabel || "").trim() || `${(label || "").trim() || "Answer"} — answer`;

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
      identity: onActivate(rowId, itemId) || null,
    };
  };

  const handleFocus = () => {
    const activated = onActivate(rowId, itemId) || null;
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
