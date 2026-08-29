import React, { useState } from "react";
import { useTheme } from "../context/ThemeContext";
import { useAuth } from "../context/AuthContext";

export const SIGN_OUT_LABEL = "Sign out";
export const SIGN_OUT_NOTE =
  "Notes stored in this browser stay here after you sign out and are available again when you sign back in.";

export default function SettingsModal({ open, onClose }) {
  const { theme, toggleTheme } = useTheme();
  const { user, signOut, resendVerification } = useAuth();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  if (!open) return null;

  const handleSignOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await signOut();
      // Success unmounts the application through the auth gate.
      if (!result.ok) setNotice(result.message);
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await resendVerification();
      setNotice(result.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-30">
      <div className="bg-white dark:bg-[#222] rounded-lg shadow-lg w-80 p-6">
        <h2 className="text-lg font-semibold mb-4 text-center">Settings</h2>
        <div className="flex items-center justify-between mb-4">
          <span className="text-gray-800 dark:text-gray-200">Theme</span>
          <button
            className={`relative w-16 h-8 bg-gray-300 dark:bg-gray-600 rounded-full transition-colors`}
            onClick={toggleTheme}
          >
            <span
              className={`absolute left-1 top-1 w-6 h-6 rounded-full bg-white dark:bg-gray-900 shadow transition-transform ${theme === "dark" ? "translate-x-8" : ""}`}
              style={{
                transition: "transform 0.2s cubic-bezier(0.4,0,0.2,1)",
              }}
            />
            <span className="sr-only">Toggle Theme</span>
          </button>
        </div>

        {/* Account — the signed-in identity, its verification state and the
            one way out. Account deletion is deliberately NOT offered here: it
            must delete cloud-owned data together with the sign-in record, and
            that coordinated workflow belongs to the cloud-persistence phase. */}
        <section className="border-t border-gray-200 dark:border-gray-700 pt-4 mb-4" aria-label="Account">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Account</div>
          <div className="text-sm text-gray-900 dark:text-gray-100 truncate" title={user?.email || undefined}>
            {user?.email || "Signed in"}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {user?.emailVerified ? (
              "Email verified"
            ) : (
              <>
                Email not verified —{" "}
                <button type="button" className="underline" onClick={handleResend} disabled={busy}>
                  resend verification email
                </button>
              </>
            )}
          </div>
          {notice && (
            <p className="text-xs mt-2 text-gray-700 dark:text-gray-300" role="status">
              {notice}
            </p>
          )}
          <button
            type="button"
            onClick={handleSignOut}
            disabled={busy}
            className="w-full mt-3 py-2 rounded border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-60"
          >
            {SIGN_OUT_LABEL}
          </button>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2 leading-snug">{SIGN_OUT_NOTE}</p>
        </section>

        <button
          onClick={onClose}
          className="w-full mt-2 py-2 rounded bg-gray-800 text-white hover:bg-gray-700"
        >
          Close
        </button>
      </div>
    </div>
  );
}
