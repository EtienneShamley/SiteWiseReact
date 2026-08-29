// src/context/DataScopeContext.js
//
// WHOSE data the repository layer is working with.
//
// Rendered inside the auth gate, so it only ever exists for a signed-in
// user; it exposes the verified identity in the shape the data layer will
// be bound to:
//
//   { uid, emailVerified, workspace: { kind: "local", id: null } }
//
// `workspace.kind` is "local" — and `id` is null — DELIBERATELY. In this
// phase every note, template and PDF still lives in this browser, owned by
// whoever uses it, exactly as before authentication existed. A workspace id
// is an authoritative, durable record of tenancy; NoteWise has no durable
// store to hold one until the cloud-persistence phase designs it, and a
// generated or hard-coded placeholder would be a fake that later code would
// trust. The context therefore says what is true: this session is user
// `uid`, working on local data that is not yet bound to any workspace.
//
// The one thing it does on the way in is RECORD the account in the local
// data binding (src/lib/localDataBinding.js) — a hint for the migration
// phase, never a claim on the data.

import React, { createContext, useContext, useEffect, useMemo } from "react";
import { useAuth } from "./AuthContext";
import { recordAccountSession } from "../lib/localDataBinding";

const DataScopeContext = createContext(null);

export const WORKSPACE_KIND = Object.freeze({ LOCAL: "local" });

export function DataScopeProvider({ children }) {
  const { user } = useAuth();
  const uid = user ? user.uid : null;
  const emailVerified = Boolean(user && user.emailVerified);

  useEffect(() => {
    if (uid) recordAccountSession(uid);
  }, [uid]);

  const value = useMemo(
    () =>
      Object.freeze({
        uid,
        emailVerified,
        workspace: Object.freeze({ kind: WORKSPACE_KIND.LOCAL, id: null }),
      }),
    [uid, emailVerified]
  );

  if (!uid) return null;
  return <DataScopeContext.Provider value={value}>{children}</DataScopeContext.Provider>;
}

export function useDataScope() {
  const ctx = useContext(DataScopeContext);
  if (!ctx) {
    throw new Error("useDataScope must be used within a DataScopeProvider (inside the auth gate)");
  }
  return ctx;
}
