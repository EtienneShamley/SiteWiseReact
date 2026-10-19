// src/components/mobile/MobileListRow.js
//
// One touch row of a phone list (Projects drill-down, PDFs). A real button
// the full width of the screen and at least 56 px tall, so it is reachable
// with a thumb and never depends on hover. The current item is marked with
// `aria-current` AND a visible word, never colour alone.
import React from "react";
import { FaChevronRight } from "react-icons/fa";

export default function MobileListRow({
  icon: Icon,
  name,
  meta = "",
  current = false,
  currentLabel = "",
  onClick,
  kind,
  id,
  chevron = true,
}) {
  const detail = [current ? currentLabel : "", meta].filter(Boolean).join(" · ");
  return (
    <li>
      <button
        type="button"
        className="nw-phone-row"
        onClick={onClick}
        aria-current={current ? "true" : undefined}
        data-nw-phone-row={kind}
        data-nw-phone-row-id={id}
      >
        {Icon && <Icon className="nw-phone-row__icon" aria-hidden="true" />}
        <span className="nw-phone-row__body">
          <span className="nw-phone-row__name">{name}</span>
          {detail && <span className="nw-phone-row__meta">{detail}</span>}
        </span>
        {chevron && <FaChevronRight className="nw-phone-row__chevron" aria-hidden="true" />}
      </button>
    </li>
  );
}
