// src/components/BusyStatus.js
//
// THE ONE inline busy indicator for a user-triggered operation that takes
// noticeable time on this device — adding an image, attaching a file, stamping
// a camera capture. It exists so the toolbar, the Free-form header, the Quick
// Add composer and the Template form's field control all report "something is
// happening" the same way, rather than each growing its own spinner.
//
// Two parts, because the consumers differ in what already exists around them:
//
//   BusySpinner  the visual only — a small ring drawn from the current text
//                colour, so it inherits whatever tone its neighbour has (muted
//                grey in a status line, document ink on the Template paper). It
//                is decorative: `aria-hidden`, with the words beside it carrying
//                the meaning. Motion is disabled under prefers-reduced-motion;
//                the static ring still reads as an indicator next to its label.
//
//   BusyStatus   spinner + label inside a polite `role="status"` live region,
//                for a surface that has no status line of its own to put the
//                spinner into.
//
// This indicates ACTIVITY, never progress: the image pipeline (decode → cap
// the long edge → re-encode → IndexedDB write) exposes no real percentage, and
// a fabricated one would be a lie. The label says what is happening ("Adding
// image…", "Processing image…") — never "Uploading…", because nothing here
// leaves the device.

import React from "react";

export function BusySpinner({ className = "" }) {
  return (
    <span
      aria-hidden="true"
      data-busy-spinner=""
      className={[
        "inline-block h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent",
        "animate-spin motion-reduce:animate-none",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

export default function BusyStatus({ label, className = "" }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={[
        "inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <BusySpinner />
      <span>{label}</span>
    </span>
  );
}
