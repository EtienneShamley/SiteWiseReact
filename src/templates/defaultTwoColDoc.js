// Default scaffold for the 2-col template doc (no fill-ins)
// Left column target within 15–20%
import { newId } from "../lib/id";

export const DEFAULT_LEFT_COL_PCT = 18;

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
// a safe fallback, src/lib/id.js) and default to the unified "text" type (a
// full-cell multiline textarea). See templateFields.js.
export function makeNewRow(label = 'New Field') {
  return { id: newId(), label, minPx: 48, px: 64, type: 'text' };
}
