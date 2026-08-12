// Default scaffold for the 2-col template doc (no fill-ins)
// Left column target within 15–20%
import { newId } from "../lib/id";
import { DEFAULT_BUILDER_FIELD_TYPE } from "../lib/templateFields";

export const DEFAULT_LEFT_COL_PCT = 18;

// The scaffold a NEW template starts from. These rows carry no `type` at all,
// which `normalizeType` resolves to the unified "text" — i.e. every one of them
// is a flexible SECTION. They are deliberately left untyped rather than being
// stamped with an explicit type: the stored bytes of every template ever
// created from this scaffold stay exactly as they are, and the read path
// already gives them the right meaning.
export const defaultRows = [
  { id: 'project_name',           label: 'Project Name',            minPx: 56, px: 72 },
  { id: 'location',               label: 'Location',                minPx: 56, px: 72 },
  { id: 'project_number',         label: 'Project Number',          minPx: 56, px: 64 },
  { id: 'time',                   label: 'Time',                    minPx: 48, px: 56 },
  { id: 'author',                 label: 'Author',                  minPx: 48, px: 56 },
  { id: 'attendance',             label: 'Attendance',              minPx: 56, px: 72 },
  { id: 'weather_site_conditions',label: 'Weather / Site Conditions', minPx: 72, px: 128 },
];

// Newly added builder rows get a stable UUID-style id (crypto.randomUUID with
// a safe fallback, src/lib/id.js) and default to a SECTION — the flexible
// document area that may later hold text, images and files in any order. Its
// stored type is the existing unified "text"; `DEFAULT_BUILDER_FIELD_TYPE` is
// imported rather than written out so the default and the builder's creation
// catalog can never drift apart. See templateFields.js.
//
// The `px` is the row's PREFERRED height while it is still empty — it is a
// starting point the user may drag, never a reserve a section carries once it
// has content: an authoritative section is content-driven and does not inherit
// `row.px` at all (see src/lib/templateRowEvidence.js).
export function makeNewRow(label = 'New Field') {
  return { id: newId(), label, minPx: 48, px: 64, type: DEFAULT_BUILDER_FIELD_TYPE };
}
