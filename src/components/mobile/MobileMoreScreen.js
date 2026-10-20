// src/components/mobile/MobileMoreScreen.js
//
// THE PHONE MORE SCREEN (Phase 8E.1) — lower-frequency functionality only.
// Primary capture (typing, Dictate, photos, files, Listen In) is never here.
//
// Settings is the existing Settings dialog (account, sign-out, sync and file
// status, photo details), opened by the application shell exactly as the
// desktop sidebar's Settings control opens it — no second account screen and
// no second sign-out path.
import React from "react";
import { FaCog, FaMoon } from "react-icons/fa";
import { useTheme } from "../../context/ThemeContext";
import { MobileHeaderBar } from "./MobileDrawerTrigger";

export default function MobileMoreScreen({ onOpenSettings }) {
  const { theme, toggleTheme } = useTheme();
  const dark = theme === "dark";
  return (
    <div className="nw-phone-screen-inner">
      <header className="nw-phone-screen-header">
        <MobileHeaderBar />
        <h1 className="nw-phone-title">More</h1>
        <p className="nw-phone-subtitle">Settings and preferences</p>
      </header>
      <ul className="nw-phone-list">
        <li>
          <button
            type="button"
            className="nw-phone-row"
            onClick={onOpenSettings}
            aria-haspopup="dialog"
            data-nw-phone-more="settings"
          >
            <FaCog className="nw-phone-row__icon" aria-hidden="true" />
            <span className="nw-phone-row__body">
              <span className="nw-phone-row__name">Settings</span>
              <span className="nw-phone-row__meta">Account, sync, files and photo details</span>
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="nw-phone-row"
            onClick={toggleTheme}
            aria-pressed={dark}
            data-nw-phone-more="theme"
          >
            <FaMoon className="nw-phone-row__icon" aria-hidden="true" />
            <span className="nw-phone-row__body">
              <span className="nw-phone-row__name">Dark theme</span>
              <span className="nw-phone-row__meta">{dark ? "On" : "Off"}</span>
            </span>
          </button>
        </li>
      </ul>
      <p className="nw-phone-hint">
        Detailed formatting and PDF annotation are easier when NoteWise is used on a larger
        screen.
      </p>
    </div>
  );
}
