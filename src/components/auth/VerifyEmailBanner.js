// src/components/auth/VerifyEmailBanner.js
//
// The standing reminder for a signed-in user whose email is not verified.
//
// Policy (Production Readiness Phase 5): an unverified account may use the
// application — its notes are its own, local to this browser — but may not
// spend: AI Refine and transcription require a verified email, on the
// backend (server/auth.js) and therefore here. The banner says so once,
// offers to resend the email and to re-check after the link was followed,
// and can be dismissed for the session; it returns on the next load until
// the address is verified.

import React, { useState } from "react";
import { useAuth } from "../../context/AuthContext";

export const VERIFY_EMAIL_BANNER_TEXT =
  "Verify your email address to use AI Refine and transcription. Check your inbox for the verification link.";
export const VERIFY_EMAIL_CHECKED_TEXT = "Your email is not verified yet. Follow the link in the email, then try again.";

export default function VerifyEmailBanner() {
  const { user, resendVerification, refreshUser } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  if (dismissed || !user || user.emailVerified) return null;

  const resend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await resendVerification();
      setNotice(result.message);
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await refreshUser();
      // A verified result unmounts this banner through the gate.
      if (result.ok && !result.emailVerified) setNotice(VERIFY_EMAIL_CHECKED_TEXT);
      else if (!result.ok && result.message) setNotice(result.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed top-0 inset-x-0 z-50 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm bg-amber-100 dark:bg-amber-900 text-amber-900 dark:text-amber-100 border-b border-amber-300 dark:border-amber-700 shadow"
      role="status"
    >
      <span className="min-w-0">
        {notice || VERIFY_EMAIL_BANNER_TEXT}
      </span>
      <span className="flex items-center gap-3 shrink-0">
        <button type="button" className="underline text-xs" onClick={resend} disabled={busy}>
          Resend email
        </button>
        <button type="button" className="underline text-xs" onClick={check} disabled={busy}>
          I've verified
        </button>
        <button
          type="button"
          className="underline text-xs"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss verification reminder"
        >
          Dismiss
        </button>
      </span>
    </div>
  );
}
