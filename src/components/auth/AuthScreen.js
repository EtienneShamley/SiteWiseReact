// src/components/auth/AuthScreen.js
//
// The signed-out experience: one card, three modes.
//
//   sign-in         email · password · Forgot password? · Create an account
//   sign-up         email · password · confirm password · Create account
//   reset           email · Send reset email
//
// Every message a user reads here is one of the fixed sentences in
// src/lib/authErrors.js; the provider's own error text never appears. Form
// pre-checks (src/lib/authModel.js) stop an obviously unusable form before
// it costs a request. Mode changes clear the previous message so a stale
// error is never shown against a different form.
//
// Styling follows the existing shell: the same surfaces, borders and the
// primary action treatment SettingsModal uses, in both themes.

import React, { useId, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { checkResetForm, checkSignInForm, checkSignUpForm } from "../../lib/authModel";
import { authFormMessage } from "../../lib/authErrors";

export const AUTH_MODE = Object.freeze({
  SIGN_IN: "sign-in",
  SIGN_UP: "sign-up",
  RESET: "reset",
});

export const AUTH_SCREEN_TITLE = Object.freeze({
  [AUTH_MODE.SIGN_IN]: "Sign in to NoteWise",
  [AUTH_MODE.SIGN_UP]: "Create your NoteWise account",
  [AUTH_MODE.RESET]: "Reset your password",
});

export const AUTH_SCREEN_ACTION = Object.freeze({
  [AUTH_MODE.SIGN_IN]: "Sign in",
  [AUTH_MODE.SIGN_UP]: "Create account",
  [AUTH_MODE.RESET]: "Send reset email",
});

export const AUTH_SCREEN_BUSY = Object.freeze({
  [AUTH_MODE.SIGN_IN]: "Signing in…",
  [AUTH_MODE.SIGN_UP]: "Creating account…",
  [AUTH_MODE.RESET]: "Sending…",
});

const LOCAL_DATA_NOTE =
  "Notes already in this browser stay here and stay yours; signing in does not move or upload them.";

const inputClass =
  "w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500";
const labelClass = "block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1";
const linkClass =
  "text-xs text-blue-700 dark:text-blue-300 underline underline-offset-2 hover:text-blue-900 dark:hover:text-blue-200";

export default function AuthScreen({ initialMode = AUTH_MODE.SIGN_IN }) {
  const { signIn, signUp, sendPasswordReset } = useAuth();
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // { kind: "error" | "notice", text }
  const [message, setMessage] = useState(null);
  const ids = useId();

  const switchMode = (next) => {
    setMode(next);
    setMessage(null);
    setPassword("");
    setConfirmPassword("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setMessage(null);

    let check;
    if (mode === AUTH_MODE.SIGN_IN) check = checkSignInForm({ email, password });
    else if (mode === AUTH_MODE.SIGN_UP) check = checkSignUpForm({ email, password, confirmPassword });
    else check = checkResetForm({ email });
    if (!check.ok) {
      setMessage({ kind: "error", text: authFormMessage(check.code) });
      return;
    }

    setBusy(true);
    try {
      if (mode === AUTH_MODE.SIGN_IN) {
        const result = await signIn(check.email, check.password);
        // Success unmounts this screen via the gate; only a failure reports.
        if (!result.ok) setMessage({ kind: "error", text: result.message });
      } else if (mode === AUTH_MODE.SIGN_UP) {
        const result = await signUp(check.email, check.password);
        if (!result.ok) setMessage({ kind: "error", text: result.message });
      } else {
        const result = await sendPasswordReset(check.email);
        setMessage({ kind: result.ok ? "notice" : "error", text: result.message });
      }
    } finally {
      setBusy(false);
    }
  };

  const emailId = `${ids}-email`;
  const passwordId = `${ids}-password`;
  const confirmId = `${ids}-confirm`;
  const messageId = `${ids}-message`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 px-4 py-8">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 shadow">
        <div className="mb-5 text-center">
          <div className="text-xl font-semibold tracking-tight text-gray-900 dark:text-white">NoteWise</div>
          <h1 className="mt-1 text-sm text-gray-600 dark:text-gray-300">{AUTH_SCREEN_TITLE[mode]}</h1>
        </div>

        <form onSubmit={handleSubmit} noValidate aria-describedby={message ? messageId : undefined}>
          <div className="mb-3">
            <label htmlFor={emailId} className={labelClass}>
              Email
            </label>
            <input
              id={emailId}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              autoFocus
            />
          </div>

          {mode !== AUTH_MODE.RESET && (
            <div className="mb-3">
              <label htmlFor={passwordId} className={labelClass}>
                Password
              </label>
              <input
                id={passwordId}
                type="password"
                name="password"
                autoComplete={mode === AUTH_MODE.SIGN_UP ? "new-password" : "current-password"}
                className={inputClass}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            </div>
          )}

          {mode === AUTH_MODE.SIGN_UP && (
            <div className="mb-3">
              <label htmlFor={confirmId} className={labelClass}>
                Confirm password
              </label>
              <input
                id={confirmId}
                type="password"
                name="confirmPassword"
                autoComplete="new-password"
                className={inputClass}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={busy}
              />
            </div>
          )}

          {message && (
            <p
              id={messageId}
              role={message.kind === "error" ? "alert" : "status"}
              className={
                message.kind === "error"
                  ? "mb-3 text-sm text-red-700 dark:text-red-300"
                  : "mb-3 text-sm text-green-700 dark:text-green-300"
              }
            >
              {message.text}
            </p>
          )}

          <button
            type="submit"
            className="w-full py-2 rounded bg-gray-800 text-white hover:bg-gray-700 disabled:opacity-60 disabled:cursor-not-allowed"
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? AUTH_SCREEN_BUSY[mode] : AUTH_SCREEN_ACTION[mode]}
          </button>
        </form>

        <div className="mt-4 flex flex-col items-center gap-2">
          {mode === AUTH_MODE.SIGN_IN && (
            <>
              <button type="button" className={linkClass} onClick={() => switchMode(AUTH_MODE.RESET)}>
                Forgot password?
              </button>
              <button type="button" className={linkClass} onClick={() => switchMode(AUTH_MODE.SIGN_UP)}>
                Create an account
              </button>
            </>
          )}
          {mode !== AUTH_MODE.SIGN_IN && (
            <button type="button" className={linkClass} onClick={() => switchMode(AUTH_MODE.SIGN_IN)}>
              Back to sign in
            </button>
          )}
        </div>

        <p className="mt-5 text-[11px] leading-snug text-gray-500 dark:text-gray-400 text-center">
          {LOCAL_DATA_NOTE}
        </p>
      </div>
    </div>
  );
}
