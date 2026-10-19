// src/components/mobile/MobileBottomNav.js
//
// THE PHONE'S PRIMARY NAVIGATION (Phase 8E.1): Projects · Note · Listen In ·
// PDFs · More — always an icon AND a text label, never an icon-only row.
//
// The current screen is marked with `aria-current="page"`, a heavier label
// and a visible indicator bar, so it is not communicated by colour alone.
// While Listen In is recording, its tab carries a red pulsing dot and its
// accessible name says "recording" in words.
//
// The bar only asks the shell to change screen; it owns no state.
import React from "react";
import {
  FaEllipsisH,
  FaFilePdf,
  FaFolder,
  FaMicrophone,
  FaRegStickyNote,
} from "react-icons/fa";
import { MOBILE_TAB, MOBILE_TAB_LABEL, MOBILE_TAB_ORDER } from "../../lib/mobileShell";

const TAB_ICON = Object.freeze({
  [MOBILE_TAB.PROJECTS]: FaFolder,
  [MOBILE_TAB.NOTE]: FaRegStickyNote,
  [MOBILE_TAB.LISTEN_IN]: FaMicrophone,
  [MOBILE_TAB.PDFS]: FaFilePdf,
  [MOBILE_TAB.MORE]: FaEllipsisH,
});

export default function MobileBottomNav({ activeTab, onSelect, listenInRecording = false }) {
  return (
    <nav className="nw-phone-nav" aria-label="Main" data-nw-phone-nav>
      <ul className="nw-phone-nav__list">
        {MOBILE_TAB_ORDER.map((tab) => {
          const Icon = TAB_ICON[tab];
          const active = tab === activeTab;
          const live = tab === MOBILE_TAB.LISTEN_IN && listenInRecording;
          return (
            <li key={tab} className="nw-phone-nav__cell">
              <button
                type="button"
                className={["nw-phone-nav__item", active ? "nw-phone-nav__item--active" : ""]
                  .filter(Boolean)
                  .join(" ")}
                aria-current={active ? "page" : undefined}
                onClick={(event) => {
                  if (typeof onSelect === "function") onSelect(tab, event.currentTarget);
                }}
                data-nw-phone-tab={tab}
                data-listen-in-live={live ? "true" : undefined}
              >
                <span className="nw-phone-nav__icon" aria-hidden="true">
                  <Icon />
                  {live && <span className="nw-phone-nav__live nw-listen-in-dot" />}
                </span>
                <span className="nw-phone-nav__label">{MOBILE_TAB_LABEL[tab]}</span>
                {live && <span className="sr-only">, recording</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
