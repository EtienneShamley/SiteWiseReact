// Small, locally defined TipTap extensions for capabilities the installed
// packages don't cover (text alignment, subscript, superscript) or cover
// incorrectly (list indent targeting). Defined here rather than installed
// as packages — @tiptap/react re-exports @tiptap/core, so no new
// dependency is needed.
import { Extension, Mark, mergeAttributes } from "@tiptap/react";

// Regular list items and task items are different node types. Indent and
// outdent must operate on whichever item type the cursor is *closest* to —
// `editor.isActive("taskItem")` matches any ancestor, so a bullet list
// nested inside a task item would wrongly indent/outdent the task item
// (outdenting with the wrong type destroys the outer list).
export function getNearestListItemType(state) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === "listItem" || name === "taskItem") return name;
  }
  return null;
}

// ListItem and TaskItem each bind Tab/Shift-Tab to their own item type,
// which mis-targets in mixed nesting (see above), and an unhandled Tab
// moves browser focus out of the editor entirely. This keymap outranks
// both (their priority is the default 100), resolves the nearest item
// type, and always swallows Tab/Shift-Tab while inside a list.
export const ListIndentKeymap = Extension.create({
  name: "listIndentKeymap",
  priority: 110,

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const type = getNearestListItemType(this.editor.state);
        if (!type) return false;
        this.editor.commands.sinkListItem(type);
        return true;
      },
      "Shift-Tab": () => {
        const type = getNearestListItemType(this.editor.state);
        if (!type) return false;
        this.editor.commands.liftListItem(type);
        return true;
      },
    };
  },
});

const ALIGNMENTS = ["left", "center", "right", "justify"];
const ALIGNABLE_TYPES = ["paragraph", "heading"];

export const TextAlign = Extension.create({
  name: "textAlign",

  addGlobalAttributes() {
    return [
      {
        types: ALIGNABLE_TYPES,
        attributes: {
          textAlign: {
            default: "left",
            parseHTML: (element) => element.style.textAlign || "left",
            renderHTML: (attributes) =>
              attributes.textAlign === "left"
                ? {}
                : { style: `text-align: ${attributes.textAlign}` },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setTextAlign:
        (alignment) =>
        ({ commands }) => {
          if (!ALIGNMENTS.includes(alignment)) return false;
          return ALIGNABLE_TYPES.map((type) =>
            commands.updateAttributes(type, { textAlign: alignment })
          ).every((ok) => ok);
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-l": () => this.editor.commands.setTextAlign("left"),
      "Mod-Shift-e": () => this.editor.commands.setTextAlign("center"),
      "Mod-Shift-r": () => this.editor.commands.setTextAlign("right"),
      "Mod-Shift-j": () => this.editor.commands.setTextAlign("justify"),
    };
  },
});

// Subscript/superscript are mutually exclusive (and self-exclusive, which
// the `excludes` override must restate since it replaces the default).
export const Subscript = Mark.create({
  name: "subscript",
  excludes: "subscript superscript",

  parseHTML() {
    return [
      { tag: "sub" },
      {
        style: "vertical-align",
        getAttrs: (value) => (value === "sub" ? null : false),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["sub", mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      toggleSubscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetSubscript:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-,": () => this.editor.commands.toggleSubscript(),
    };
  },
});

export const Superscript = Mark.create({
  name: "superscript",
  excludes: "subscript superscript",

  parseHTML() {
    return [
      { tag: "sup" },
      {
        style: "vertical-align",
        getAttrs: (value) => (value === "super" ? null : false),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      toggleSuperscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetSuperscript:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-.": () => this.editor.commands.toggleSuperscript(),
    };
  },
});
