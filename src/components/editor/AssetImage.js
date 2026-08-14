// src/components/editor/AssetImage.js
//
// THE SHARED NOTEWISE IMAGE NODE — extension and NodeView.
//
// It extends the installed TipTap Image extension rather than replacing it,
// adding two capabilities:
//
//   - an image may be a REFERENCE to a Blob in IndexedDB (`assetId`) instead
//     of carrying its own bytes;
//   - every supported image — asset-backed, legacy base64, remote — is one
//     directly manipulable NoteWise image object: click to select, four corner
//     handles for proportional resize, Alt/Option+←/→ keyboard resize, an
//     explicit Remove control, and a pointer-owned BODY DRAG that moves the
//     block image to a real ProseMirror document position (Phase C2).
//
// This file is shared editor infrastructure (docs/PROJECT_DECISIONS.md →
// "Shared NoteWise Editor Core"): nothing in it is Free-form-specific, and the
// future per-Section Template editor consumes the same node and NodeView.
//
// Serialization and parsing guarantees are unchanged from the original node:
//
//  - Serialization. Every attribute renders through one pure function
//    (editorImageAttrsToHTML), so the stored note HTML can never contain a
//    `blob:` URL, and an asset-backed image can never contain a `src` at all.
//
//  - Parsing. The stock extension parses `img[src]:not([src^="data:"])`, which
//    silently DROPS a base64 image whenever the note HTML is re-parsed.
//    Existing notes contain such images from the previous data-URL stopgap, so
//    `allowBase64` is enabled and the parse rules below also match an <img>
//    that has a data-asset-id and no src at all.
//
// NODEVIEW RESPONSIBILITIES — presentation and gesture ONLY. Every document
// change goes through a command (`updateMediaAttrs`, `deleteNode`), each of
// which is one ProseMirror transaction and therefore one undo step flowing
// through the surface's own autosave. No persistence logic lives here.
//
//   - resolve and render the image (asset id via the shared object-URL hook;
//     remote/legacy src directly; a missing asset renders readable text);
//   - selection chrome while the node is ProseMirror-NodeSelected;
//   - four corner resize handles (shared arithmetic, live preview only, ONE
//     transaction on release — see editorMediaResizeGesture.js);
//   - a Remove control (deleteNode — the same transaction Backspace/Delete on
//     a selected node dispatches through the editor's own keymap);
//   - body drag (shared gesture over the shared session; ghost + insertion
//     indicator while moving, ONE moveMediaNode transaction on drop, zero on
//     cancel — see editorMediaDragGesture.js / editorMediaDrag.js). The
//     node spec is `draggable: false` and every native dragstart inside the
//     view is prevented, so the browser's HTML5 node drag — the old,
//     inconsistent move path — cannot compete with this gesture.
import React, { useCallback, useEffect, useRef, useState } from "react";
import Image from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import useAssetObjectUrl from "../../hooks/useAssetObjectUrl";
import {
  EDITOR_IMAGE_ASSET_ATTR,
  EDITOR_IMAGE_LOADING_TEXT,
  EDITOR_IMAGE_UNAVAILABLE_TEXT,
  editorImageAttrsFromElement,
  editorImageAttrsToHTML,
  isPersistableImageSrc,
} from "../../lib/editorImageAssets";
import {
  MEDIA_CLASS,
  MEDIA_LAYOUT_MODE,
  mediaLayoutClassNames,
  mediaWidthStyle,
  normalizeMediaWidthPct,
} from "../../lib/editorMediaLayout";
import {
  MEDIA_RESIZE_CORNERS,
  mediaCornerResizeCursor,
} from "../../lib/editorMediaResize";
import { beginMediaResizeGesture } from "../../lib/editorMediaResizeGesture";
import {
  moveMediaNode,
  resolveMediaDragDestination,
} from "../../lib/editorMediaDrag";
import {
  beginMediaBodyDragGesture,
  suppressMediaGestureTrailingClick,
} from "../../lib/editorMediaDragGesture";
import { createMediaDragGhost } from "../../lib/editorMediaDragGhost";
import {
  nudgeSelectedMediaWidth,
  updateMediaAttrs,
} from "../../lib/editorCommands";
import {
  createMediaDropIndicatorPlugin,
  setMediaDragState,
} from "./mediaDropIndicatorPlugin";

/** An element's content-box width in px, or null when it cannot be measured. */
function contentBoxWidth(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  const rect = el.getBoundingClientRect();
  let width = rect && Number.isFinite(rect.width) ? rect.width : 0;
  const win = el.ownerDocument && el.ownerDocument.defaultView;
  if (win && typeof win.getComputedStyle === "function") {
    const cs = win.getComputedStyle(el);
    width -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  }
  return width > 0 ? width : null;
}

/**
 * The width percentage a node view wrapper currently RENDERS at, measured
 * against the content box `widthPct` is a percentage of. This is how a legacy
 * image — which has no stored widthPct — gets a truthful starting width for a
 * resize, so its first gesture begins from the size the user actually sees.
 */
function measuredWidthPctOf(wrapperEl) {
  if (!wrapperEl || !wrapperEl.parentElement) return null;
  const container = contentBoxWidth(wrapperEl.parentElement);
  if (!container) return null;
  const rect = wrapperEl.getBoundingClientRect();
  if (!rect || !(rect.width > 0)) return null;
  return normalizeMediaWidthPct((rect.width / container) * 100);
}

/** The sized wrapper inside whatever DOM ProseMirror holds for the node. */
function nodeViewWrapperOf(dom) {
  if (!dom) return null;
  if (typeof dom.matches === "function" && dom.matches("[data-node-view-wrapper]")) {
    return dom;
  }
  if (typeof dom.querySelector === "function") {
    return dom.querySelector("[data-node-view-wrapper]") || dom;
  }
  return dom;
}

// No native HTML5 drag may start anywhere inside this node view — an <img> is
// natively draggable by default, and image movement is the pointer-owned body
// drag below. Two drag systems competing for one gesture was exactly the
// inconsistency C2 replaces.
const stopDrag = (e) => {
  e.preventDefault();
  e.stopPropagation();
};

function AssetImageView({ node, editor, getPos, selected, deleteNode }) {
  const { assetId, src, alt, title, width, height } = node.attrs;
  // The hook is called unconditionally (rules of hooks) and no-ops for a
  // non-asset image, which is what keeps remote and legacy images on the same
  // component without a second renderer.
  const { url, status } = useAssetObjectUrl(assetId || null);

  // The live resize preview: inline width only, NEVER the document. Null when
  // idle, so a cancelled gesture reverts by itself — the rendered width falls
  // back to the persisted attribute.
  const [previewPct, setPreviewPct] = useState(null);
  const [resizing, setResizing] = useState(false);
  // An ARMED body drag: the source stays in place but fades, so the ghost
  // reads as the image in hand rather than a second copy.
  const [draggingBody, setDraggingBody] = useState(false);
  const wrapperRef = useRef(null);
  const gestureRef = useRef(null);
  const bodyDragRef = useRef(null);
  // Cancels an armed trailing-click suppression on unmount; it otherwise
  // resolves itself on the very next click or pointerdown.
  const suppressClickRef = useRef(null);

  // Unmount abandons an in-flight gesture uncommitted. Ending the body drag
  // runs its settle path, which destroys the ghost and clears the indicator.
  useEffect(
    () => () => {
      if (gestureRef.current) gestureRef.current.end();
      if (bodyDragRef.current) bodyDragRef.current.end();
      if (suppressClickRef.current) suppressClickRef.current();
    },
    []
  );

  const editable = !!(editor && editor.isEditable);
  const storedPct = normalizeMediaWidthPct(node.attrs.widthPct);
  const effectivePct = previewPct !== null ? previewPct : storedPct;

  // Clicking the image body selects the node. ProseMirror selects a leaf node
  // on mousedown by itself in the common case; this explicit fallback covers
  // the placeholder states and keeps selection PM-native — it IS a
  // NodeSelection, just dispatched deliberately.
  const selectSelf = useCallback(() => {
    if (!editable || selected) return;
    if (typeof getPos !== "function") return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.commands.setNodeSelection(pos);
  }, [editable, selected, getPos, editor]);

  const handleRemove = useCallback(() => {
    if (typeof deleteNode === "function") deleteNode();
  }, [deleteNode]);

  /**
   * One corner press begins one gesture, synchronously — the immutable
   * geometry (corner, pointer, start x, start width, container width) is
   * captured NOW and never re-derived from the box being resized. Movement
   * previews through state; release commits through updateMediaAttrs exactly
   * once (see editorMediaResizeGesture.js for the commit policy).
   */
  const beginCornerResize = useCallback(
    (corner) => (event) => {
      if (!editable) return;
      if (typeof event.button === "number" && event.button !== 0) return;
      if (event.isPrimary === false) return;
      // One gesture at a time — a body drag in flight (a second pointer,
      // for instance) must not mint a competing resize.
      if (gestureRef.current || bodyDragRef.current) return;

      const wrapper = wrapperRef.current;
      const container =
        wrapper && wrapper.parentElement
          ? contentBoxWidth(wrapper.parentElement)
          : null;
      // Each gesture starts from the PERSISTED width; a legacy image starts
      // from the width it actually renders at.
      const startPct = storedPct !== null ? storedPct : measuredWidthPctOf(wrapper);
      if (container === null || startPct === null) return;

      event.preventDefault();
      event.stopPropagation();

      const gesture = beginMediaResizeGesture({
        win: window,
        corner,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidthPct: startPct,
        containerWidth: container,
        onPreview: (pct) => setPreviewPct(pct),
        onCommit: (pct) => updateMediaAttrs(editor, { widthPct: pct }),
        onSettle: () => {
          gestureRef.current = null;
          setResizing(false);
          setPreviewPct(null);
        },
      });
      if (!gesture) return;

      gestureRef.current = gesture;
      setResizing(true);
      // The preview starts at the width it already has, so a press alone can
      // never change the rendered size.
      setPreviewPct(startPct);
    },
    [editable, editor, storedPct]
  );

  /**
   * One press on the image BODY begins one candidate move, synchronously — no
   * preventDefault at pointerdown, because below the ~4px threshold this press
   * is an ordinary click and ProseMirror's own selection must keep working.
   * Crossing the threshold arms the drag: ghost + insertion indicator +
   * trailing-click suppression. Movement only ever previews (ghost position,
   * candidate destination via the shared resolver — real posAtCoords document
   * positions); release commits through moveMediaNode exactly once, and every
   * abandoning exit (Escape, pointercancel, stale gesture, unmount) commits
   * nothing and tears the presentation down through the one settle path.
   *
   * The corner handles and the Remove control are separate elements whose own
   * handlers never reach this one, so resize and Remove can never begin a move.
   */
  const beginBodyDrag = useCallback(
    (event) => {
      if (!editable) return;
      if (typeof event.button === "number" && event.button !== 0) return;
      if (event.isPrimary === false) return;
      // One gesture at a time — a resize in flight, or a second pointer
      // pressing mid-drag, cannot mint a competing session.
      if (gestureRef.current || bodyDragRef.current) return;

      const view = editor && editor.view;
      if (!view) return;

      // WHAT THE GHOST WILL SHOW, captured now, synchronously, while the event
      // is still being dispatched: the rendered src and the image's box on the
      // page. A source that cannot be read simply produces no ghost; the move
      // itself still works.
      const img = event.currentTarget;
      const box =
        img && typeof img.getBoundingClientRect === "function"
          ? img.getBoundingClientRect()
          : null;
      const runtime = {
        src: (img && (img.currentSrc || img.src)) || null,
        rect: box
          ? { left: box.left, top: box.top, width: box.width, height: box.height }
          : null,
        grabX: event.clientX,
        grabY: event.clientY,
        ownerDoc: img && img.ownerDocument ? img.ownerDocument : null,
        ghost: null,
        lastPos: null,
      };

      const srcPosOf = () => {
        if (typeof getPos !== "function") return null;
        const pos = getPos();
        return typeof pos === "number" ? pos : null;
      };

      const gesture = beginMediaBodyDragGesture({
        win: window,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        onArm: () => {
          // The drag genuinely moved, so the click its release will generate
          // is not something the user asked for — consume exactly that one.
          suppressClickRef.current = suppressMediaGestureTrailingClick({
            win: window,
          });
          runtime.ghost = createMediaDragGhost({
            doc: runtime.ownerDoc,
            src: runtime.src,
            rect: runtime.rect,
            grabX: runtime.grabX,
            grabY: runtime.grabY,
          });
          setMediaDragState(view, { active: true, pos: null });
          setDraggingBody(true);
        },
        onDragMove: (e) => {
          if (runtime.ghost) runtime.ghost.moveTo(e.clientX, e.clientY);
          const from = srcPosOf();
          const dest =
            from === null
              ? null
              : resolveMediaDragDestination(view, {
                  x: e.clientX,
                  y: e.clientY,
                  srcPos: from,
                });
          const pos = dest ? dest.pos : null;
          if (pos !== runtime.lastPos) {
            runtime.lastPos = pos;
            setMediaDragState(view, { active: true, pos });
          }
        },
        onDrop: (e) => {
          const from = srcPosOf();
          if (from === null) return;
          const dest = resolveMediaDragDestination(view, {
            x: e.clientX,
            y: e.clientY,
            srcPos: from,
          });
          if (dest) moveMediaNode(view, { from, to: dest.pos });
        },
        onSettle: ({ armed }) => {
          bodyDragRef.current = null;
          if (runtime.ghost) {
            runtime.ghost.destroy();
            runtime.ghost = null;
          }
          if (armed) {
            setMediaDragState(view, { active: false, pos: null });
            setDraggingBody(false);
          }
        },
      });
      if (!gesture) return;
      bodyDragRef.current = gesture;
    },
    [editable, editor, getPos]
  );

  const label = alt || "Image";
  const dimensionProps = {};
  if (Number(width) > 0) dimensionProps.width = Math.round(Number(width));
  if (Number(height) > 0) dimensionProps.height = Math.round(Number(height));

  let body;
  let renderable = false;
  if (assetId) {
    if (status === "loading") {
      body = (
        <span className="note-image-placeholder" role="status" onClick={selectSelf}>
          {EDITOR_IMAGE_LOADING_TEXT}
        </span>
      );
    } else if (status === "ready" && url) {
      renderable = true;
      body = (
        <img
          src={url}
          alt={label}
          title={title || undefined}
          draggable={false}
          onClick={selectSelf}
          onPointerDown={beginBodyDrag}
          onDragStart={stopDrag}
          {...dimensionProps}
        />
      );
    } else {
      body = (
        <span
          className="note-image-placeholder note-image-placeholder--missing"
          onClick={selectSelf}
        >
          {EDITOR_IMAGE_UNAVAILABLE_TEXT}
          {alt ? ` (${alt})` : ""}
        </span>
      );
    }
  } else if (isPersistableImageSrc(src)) {
    // A remote http/https image, or a legacy data:image kept for compatibility.
    renderable = true;
    body = (
      <img
        src={src}
        alt={label}
        title={title || undefined}
        draggable={false}
        onClick={selectSelf}
        onPointerDown={beginBodyDrag}
        onDragStart={stopDrag}
        {...dimensionProps}
      />
    );
  } else {
    body = (
      <span
        className="note-image-placeholder note-image-placeholder--missing"
        onClick={selectSelf}
      >
        {EDITOR_IMAGE_UNAVAILABLE_TEXT}
      </span>
    );
  }

  const showChrome = selected && editable;
  // A placeholder has no meaningful proportional width, so it offers Remove
  // but no resize handles.
  const showHandles = showChrome && renderable;

  const classNames = [
    "note-image-node",
    ...mediaLayoutClassNames({ mode: node.attrs.layoutMode, side: node.attrs.layoutSide }),
    effectivePct !== null ? `${MEDIA_CLASS}--sized` : "",
    showChrome ? `${MEDIA_CLASS}--selected` : "",
    resizing ? `${MEDIA_CLASS}--resizing` : "",
    draggingBody ? `${MEDIA_CLASS}--dragging` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      as="div"
      className={classNames}
      style={mediaWidthStyle(effectivePct) || undefined}
      onDragStart={stopDrag}
    >
      {body}

      {showChrome && (
        <div
          className={`${MEDIA_CLASS}-controls`}
          role="toolbar"
          aria-label={`Image options for ${label}`}
          contentEditable={false}
          onDragStart={stopDrag}
        >
          <button
            type="button"
            className={`${MEDIA_CLASS}-btn ${MEDIA_CLASS}-btn--danger`}
            onClick={handleRemove}
            title={`Remove image ${label}`}
            aria-label={`Remove image ${label}`}
          >
            Remove
          </button>
        </div>
      )}

      {showHandles &&
        MEDIA_RESIZE_CORNERS.map((corner) => (
          <div
            key={corner}
            className={`${MEDIA_CLASS}-corner ${MEDIA_CLASS}-corner--${corner}`}
            role="presentation"
            title="Drag a corner to resize this image"
            style={{ cursor: mediaCornerResizeCursor(corner) }}
            onPointerDown={beginCornerResize(corner)}
            onDragStart={stopDrag}
          />
        ))}
    </NodeViewWrapper>
  );
}

export const AssetImage = Image.extend({
  // The stock Image node is `draggable: true`, which handed image movement to
  // the browser's HTML5 drag-and-drop — the old, inconsistent vertical moves.
  // Movement is now the pointer-owned body drag in the NodeView above, so the
  // native path is switched off at the schema; exactly one drag system exists.
  draggable: false,

  // Legacy notes hold data: images; refusing to parse them would delete them.
  addOptions() {
    return {
      ...this.parent?.(),
      allowBase64: true,
    };
  },

  addAttributes() {
    // Every attribute renders nothing on its own — the node's renderHTML below
    // emits the whole set through one pure function, so there is exactly one
    // place that decides what a persisted image may contain.
    const none = () => ({});
    return {
      src: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).src,
        renderHTML: none,
      },
      alt: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).alt,
        renderHTML: none,
      },
      title: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).title,
        renderHTML: none,
      },
      width: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).width,
        renderHTML: none,
      },
      height: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).height,
        renderHTML: none,
      },
      assetId: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).assetId,
        renderHTML: none,
      },
      // Shared media-core presentation attributes (editorMediaLayout.js). The
      // defaults are never emitted, so an existing document renders and
      // round-trips exactly as before.
      widthPct: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).widthPct,
        renderHTML: none,
      },
      layoutMode: {
        default: MEDIA_LAYOUT_MODE.BLOCK,
        parseHTML: (el) => editorImageAttrsFromElement(el).layoutMode,
        renderHTML: none,
      },
      layoutSide: {
        default: null,
        parseHTML: (el) => editorImageAttrsFromElement(el).layoutSide,
        renderHTML: none,
      },
    };
  },

  parseHTML() {
    return [
      // An asset-backed image has NO src, so it needs its own rule.
      { tag: `img[${EDITOR_IMAGE_ASSET_ATTR}]` },
      { tag: "img[src]" },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    // Anything another extension contributed passes through, EXCEPT the two
    // attributes this node owns: whatever route a src or an asset id arrived
    // by, the pure serializer below is the only thing allowed to emit them.
    const passthrough = { ...(HTMLAttributes || {}) };
    delete passthrough.src;
    delete passthrough[EDITOR_IMAGE_ASSET_ATTR];

    return [
      "img",
      mergeAttributes(
        this.options.HTMLAttributes,
        passthrough,
        editorImageAttrsToHTML(node.attrs)
      ),
    ];
  },

  addKeyboardShortcuts() {
    // Alt/Option + ←/→ resizes the SELECTED image in 5% steps — one key
    // action, one transaction, same clamp as the pointer path. Any other
    // selection returns false, so the keys keep their ordinary meaning.
    // Backspace/Delete are deliberately NOT bound here: deleting a selected
    // node is the editor's own base behaviour and must stay untouched.
    const nudge = (direction) => () =>
      nudgeSelectedMediaWidth(this.editor, direction, {
        measureWidthPct: () => {
          const view = this.editor && this.editor.view;
          if (!view || typeof view.nodeDOM !== "function") return null;
          const dom = view.nodeDOM(this.editor.state.selection.from);
          return measuredWidthPctOf(nodeViewWrapperOf(dom));
        },
      });
    return {
      "Alt-ArrowRight": nudge(1),
      "Alt-ArrowLeft": nudge(-1),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(AssetImageView);
  },

  addProseMirrorPlugins() {
    // The body-drag insertion indicator travels WITH the node: every surface
    // that installs AssetImage gets it, with no per-surface wiring.
    return [createMediaDropIndicatorPlugin()];
  },
});

export default AssetImage;
