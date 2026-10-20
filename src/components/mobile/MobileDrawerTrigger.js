// src/components/mobile/MobileDrawerTrigger.js
//
// THE WAY INTO THE PHONE NAVIGATION DRAWER (2026-10-21): a ☰ button in the
// header of every phone screen, reached through the screens' EXISTING header
// rows — the bottom navigation is unchanged.
//
// The drawer itself is the phone shell's (PhoneShell → MobileDrawer); screens
// only ask for it through this context. Outside the phone shell there is no
// context, the trigger renders nothing, and `MobileHeaderBar` renders its
// children exactly as before — so a screen mounted on its own (tests, any
// future host) is unchanged.
import React, { createContext, useContext } from "react";
import { FaBars } from "react-icons/fa";

export const MOBILE_DRAWER_ID = "nw-phone-drawer";
export const MOBILE_DRAWER_OPEN_LABEL = "Open navigation menu";

/** { open(trigger), isOpen } — provided by PhoneShell only. */
export const PhoneDrawerContext = createContext(null);

export function usePhoneDrawer() {
  return useContext(PhoneDrawerContext);
}

export default function MobileDrawerTrigger() {
  const drawer = usePhoneDrawer();
  if (!drawer) return null;
  return (
    <button
      type="button"
      className="nw-phone-drawer-trigger"
      onClick={(event) => drawer.open(event.currentTarget)}
      aria-label={MOBILE_DRAWER_OPEN_LABEL}
      aria-haspopup="dialog"
      aria-expanded={!!drawer.isOpen}
      aria-controls={MOBILE_DRAWER_ID}
      data-nw-phone-drawer-trigger
    >
      <FaBars aria-hidden="true" />
    </button>
  );
}

/**
 * The top row of a phone screen header: the ☰ trigger, then whatever the
 * screen already had there (a Back button). Without a drawer it is exactly
 * the children, so the header's existing markup is untouched off the shell.
 */
export function MobileHeaderBar({ children = null }) {
  const drawer = usePhoneDrawer();
  if (!drawer) return children;
  return (
    <div className="nw-phone-header-bar">
      <MobileDrawerTrigger />
      {children}
    </div>
  );
}
