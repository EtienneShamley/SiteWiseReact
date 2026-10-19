// src/components/editor/FreeformPagedEditorZoom.test.js
//
// The Free-form paged editor RENDERED over a real Tiptap editor at the phone
// ladder's extremes (Phase 8E.1): the zoom scale reaches the stylesheet as a
// custom property on the shell, the document's content is byte-identical at
// 25% and 150%, and no editor transaction is dispatched by zooming.
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import FreeformPagedEditor from "./FreeformPagedEditor";
import { editorCoreExtensions } from "./editorCoreExtensions";
import { PHONE_DOCUMENT_ZOOM_LEVELS, zoomScale } from "../../lib/documentZoom";
import { FREEFORM_ZOOM_SCALE_VAR } from "../../lib/freeformPaperScale";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HTML = "<p>Crack in the north abutment, photographed.</p><p>Second paragraph.</p>";

let editor;
let host;
let root;

beforeEach(() => {
  editor = new Editor({ element: document.createElement("div"), extensions: editorCoreExtensions(), content: HTML });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  editor.destroy();
});

const render = (zoom) => act(() => root.render(<FreeformPagedEditor editor={editor} documentZoom={zoom} />));
const shell = () => host.querySelector(".nw-ff-paged-shell");

test("the shell carries the zoom scale as --nw-doc-zoom-scale, following the displayed percentage", () => {
  for (const zoom of PHONE_DOCUMENT_ZOOM_LEVELS) {
    render(zoom);
    expect(shell().style.getPropertyValue(FREEFORM_ZOOM_SCALE_VAR)).toBe(String(zoomScale(zoom)));
  }
});

test("zooming from 150% to 25% and back leaves the document byte-identical and dispatches no transaction", () => {
  render(100);
  const before = editor.getHTML();
  const transactions = [];
  const onTransaction = ({ transaction }) => {
    // The page-guide plugin's own layout metadata is not a content change;
    // any transaction that changes the document would be.
    if (transaction.docChanged) transactions.push(transaction);
  };
  editor.on("transaction", onTransaction);
  render(150);
  render(25);
  render(100);
  editor.off("transaction", onTransaction);
  expect(editor.getHTML()).toBe(before);
  expect(transactions).toHaveLength(0);
  // The same one editor, never recreated by zoom.
  expect(host.querySelectorAll(".ProseMirror")).toHaveLength(1);
});
