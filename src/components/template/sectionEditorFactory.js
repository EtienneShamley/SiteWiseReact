// src/components/template/sectionEditorFactory.js
//
// THE ONE PLACE A FLEXIBLE TEMPLATE SECTION'S EDITOR IS CONSTRUCTED.
//
// It builds a real Tiptap `Editor` from the shared NoteWise editor core
// (src/components/editor/sectionEditorExtensions.js — the ONE shared extension
// list, configured with the Section policy: the full document vocabulary the
// top toolbar exposes PLUS the shared `AssetImage` and the shared
// `FileAttachment`, placed at the top level and configured with the Section's
// own accepted asset kind). Nothing about images, files, selection, resize,
// drag, wrap or history is implemented here or anywhere else on the Template
// side: those live in the shared nodes and their shared NodeViews, and a
// Section gets them by using the same extensions the Free-form note uses.
//
// WHY `new Editor` AND NOT `useEditor`
// -----------------------------------
// `useEditor` destroys its editor when the component that owns it unmounts, and
// retention is the whole point: deactivating a Section must keep its instance —
// and therefore its UNDO HISTORY — alive so reactivating it can undo work done
// before the user went elsewhere. The instance is owned by the per-note
// registry (src/lib/sectionEditorRegistry.js) and merely MOUNTED by
// <TemplateSectionEditor>; `EditorContent`'s own unmount path moves the
// editor's DOM back to a detached element and re-attaches it on the next mount,
// which is exactly the behaviour retention needs.
//
// THE DOCUMENT IS READ ONCE, AT CONSTRUCTION
// ------------------------------------------
// `content` is supplied to the constructor rather than set afterwards, which is
// why creating a Section editor emits no update, creates no history entry and
// therefore writes nothing. A retained editor is never re-seeded from storage:
// its own state is the newer truth, and re-seeding would silently discard what
// the user just typed together with their ability to undo it.
//
// THE ROOT CARRIES `nw-editor-root`, NEVER `note-editor`
// -----------------------------------------------------
// `twocol-rich-input` is the Template answer box model and typography, so an
// active Section is exactly the size of the static view it replaced.
// `MEDIA_EDITOR_ROOT_CLASS` is the shared media/file chrome scope. `note-editor`
// is deliberately absent: every `.dark .note-editor …` override stays qualified
// by it, so a Section editor always renders the LIGHT chrome its white Template
// paper needs whatever the app-wide theme is (see editor.css, Phase F2).

import { Editor } from "@tiptap/core";
import {
  SECTION_FILE_ASSET_KINDS,
  sectionEditorExtensions,
} from "../editor/sectionEditorExtensions";
import { MEDIA_EDITOR_ROOT_CLASS } from "../../lib/editorMediaLayout";
import { PHOTO_MAX_HEIGHT_PX } from "./PhotoAttachment";

/** The class list on a Section editor's ProseMirror content element. */
export const SECTION_EDITOR_CONTENT_CLASS = `twocol-rich-input ${MEDIA_EDITOR_ROOT_CLASS} nw-tpl-section-editor`;

/** The editorProps a Section editor uses. Rebuilt when its label changes. */
export function sectionEditorProps(ariaLabel) {
  return {
    attributes: {
      class: SECTION_EDITOR_CONTENT_CLASS,
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": ariaLabel || "Section",
      spellCheck: "true",
    },
  };
}

/**
 * Construct ONE Section editor.
 *
 * @param html      the document to open, already serialized by the canonical
 *                  body reader (`sectionBodyHtml`) — a stored modern document,
 *                  or a legacy body adapted into one. NEVER raw stored HTML
 *                  from anywhere else.
 * @param editable  whether the Template view is currently the live surface
 * @param ariaLabel the accessible name of this Section's answer area
 * @param onUpdate  ({ editor }) => void, called ONLY for a genuine document
 *                  change (Tiptap emits `update` only when a transaction has
 *                  `docChanged` and the resulting document actually differs, so
 *                  selection, focus/blur and the media drag indicator's
 *                  meta-only transactions never reach it)
 *
 * Returns the editor, or null when it could not be constructed — the registry
 * then remembers nothing and the caller falls back to the static rendering
 * rather than presenting a Section that cannot be typed into.
 */
export function createSectionEditor({ html, editable, ariaLabel, onUpdate } = {}) {
  try {
    return new Editor({
      extensions: sectionEditorExtensions({
        acceptedFileAssetKinds: SECTION_FILE_ASSET_KINDS,
        // The EXISTING Template rule, not a new number: a Section image lives
        // in an atomic, pageable block and so may never render taller than one
        // usable page. The static Section view applies the identical cap
        // through the identical shared helper.
        maxImageDisplayHeightPx: PHOTO_MAX_HEIGHT_PX,
      }),
      // Read once, at creation — see the module note.
      content: typeof html === "string" ? html : "",
      editable: editable !== false,
      editorProps: sectionEditorProps(ariaLabel),
      onUpdate: ({ editor }) => {
        if (typeof onUpdate === "function") onUpdate({ editor });
      },
    });
  } catch {
    return null;
  }
}

export default createSectionEditor;
