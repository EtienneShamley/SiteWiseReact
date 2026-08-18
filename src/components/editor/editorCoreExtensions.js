// src/components/editor/editorCoreExtensions.js
//
// THE SHARED NOTEWISE EDITOR CORE — the ONE extension set every NoteWise
// document surface is built from.
//
// The Free-form note editor (src/components/MainArea.js) and the flexible
// Template Section editor (src/components/template/sectionEditorFactory.js via
// sectionEditorExtensions.js) both construct their Tiptap editor from the array
// this module returns. That is what makes "the toolbar" one toolbar: the same
// nodes, the same marks, the same commands and the same keymaps exist on both
// surfaces, so a control that works in a Free-form note works in a Section,
// and the toolbar's availability can be DERIVED from the owning editor's schema
// (src/lib/editorCapabilities.js) instead of being maintained by hand.
//
// A surface differs from the core ONLY through the configuration below, and
// only for a genuine product / data / security reason:
//
//   trailingNode   Free-form keeps StarterKit's TrailingNode; a Section turns
//                  it off, because "opening a Section writes nothing" is a
//                  hard rule and TrailingNode edits the document on the first
//                  transaction of any kind (see sectionEditorExtensions.js).
//   image / file   the SAME shared media nodes, optionally `.configure()`d by
//                  the surface (a Section caps image display height and
//                  accepts its own file asset kind) or `.extend()`ed with the
//                  surface's placement policy (a Section's media are page-level
//                  blocks — see SECTION MEDIA in sectionEditorExtensions.js).
//   document       the surface's Document node when its top-level content
//                  expression differs from StarterKit's `block+`.
//
// There is deliberately no other knob. A capability is never switched off for
// one surface merely because that surface's older code lacked it.
//
// The list itself is the Free-form editor's historical extension list, moved
// here (StarterKit v3 with its bundled underline / blockquote / horizontal
// rule / code block kept, its bundled link replaced by the configured Link,
// the local alignment / sub-superscript / list-indent extensions, tables, task
// lists, fonts and colour). Nothing was added or removed for either surface.
//
// CODE BLOCK. The Free-form list used to register `CodeBlockLowlight` around a
// `createLowlight()` instance with NO grammar registered — which, verified
// against the extension's own plugin, produces no highlight decoration at all
// (an empty registry auto-highlights to one unclassed text node). The core
// therefore uses StarterKit's own `CodeBlock`: the same `codeBlock` node, the
// same `language` attribute, the same `<pre><code class="language-…">` HTML,
// identical rendering — and one fewer moving part. `lowlight` and the lowlight
// extension remain installed dependencies (removal is a separate decision).

import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import FontFamily from "@tiptap/extension-font-family";
import { TextStyle, FontSize } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { ListIndentKeymap, Subscript, Superscript, TextAlign } from "./extensions";
import { AssetImage } from "./AssetImage";
import { FileAttachment } from "./FileAttachment";
import { RefineTargetHighlight } from "./refineTargetPlugin";

/**
 * @param trailingNode  keep StarterKit's TrailingNode (default true)
 * @param image         the shared AssetImage node, possibly configured/extended
 * @param file          the shared FileAttachment node, possibly configured/extended
 * @param document      an override Document extension, or null for StarterKit's
 */
export function editorCoreExtensions({
  trailingNode = true,
  image = AssetImage,
  file = FileAttachment,
  document = null,
} = {}) {
  return [
    StarterKit.configure({
      // Registered below with `openOnClick: false`, so a link never navigates
      // while it is being edited.
      link: false,
      trailingNode,
      ...(document ? { document: false } : {}),
    }),
    ...(document ? [document] : []),
    Link.configure({ openOnClick: false }),
    // multicolor is required for the toolbar's highlight colour picker.
    Highlight.configure({ multicolor: true }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    // The image node extended with an IndexedDB asset reference: bytes go to
    // the asset store and the document carries only an assetId, so note HTML
    // never holds image data. It also parses legacy data: images. See
    // ./AssetImage.js.
    image,
    // A file attached to the note: a selectable atom block carrying only an
    // IndexedDB reference and its display metadata. See ./FileAttachment.js.
    file,
    TaskList,
    // nested is required for the toolbar's indent inside task lists.
    TaskItem.configure({ nested: true }),
    // Locally defined (see ./extensions.js): corrected list indent/outdent
    // keymap, alignment, subscript, superscript.
    ListIndentKeymap,
    TextAlign,
    Subscript,
    Superscript,
    FontFamily,
    TextStyle,
    FontSize,
    Color,
    // The pending AI Refine target's highlight (see ./refineTargetPlugin.js).
    // Decoration only: it never changes the document, never records history and
    // never triggers a save, and it lives in the SHARED core so the Free-form
    // note and every Template Section show the target the same way.
    RefineTargetHighlight,
  ];
}

export default editorCoreExtensions;
