// src/lib/cloud/workspaceBootstrap.js
//
// FIRST-USER BOOTSTRAP: how an authenticated uid resolves to exactly one
// workspace it is a member of — idempotently, race-safely, on every sign-in.
//
// The coordination point is `users/{uid}.defaultWorkspaceId`. Everything
// happens in ONE Firestore transaction (serializable: two concurrent
// bootstraps of the same uid cannot both create a workspace — the loser
// retries, reads the winner's pointer and resolves the same workspace):
//
//   read users/{uid}
//   ├─ has defaultWorkspaceId → read workspaces/{wid}/members/{uid}
//   │     ├─ exists           → resolved (nothing written)
//   │     └─ missing          → the ONLY partial state that can exist (a
//   │                           workspace this user owns without its member
//   │                           document — e.g. a rules change mid-flight):
//   │                           re-create the OWNER membership if the
//   │                           workspace says this uid owns it; otherwise
//   │                           refuse (never claim someone else's workspace)
//   └─ none                  → create workspaces/{wid} (ownerUid = uid),
//                              workspaces/{wid}/members/{uid} (role owner),
//                              set users/{uid}.defaultWorkspaceId — atomically
//
// Security Rules (firestore.rules) permit exactly these writes and nothing
// wider: a user may create a workspace only with themselves as owner, may
// create only their OWN owner-membership and only in a workspace whose
// (post-write) owner is themselves, may never change a workspace's owner,
// and may never re-point their user record at a workspace they are not a
// member of. So an attacker cannot invent membership in an existing
// workspace, and a client cannot make the server trust a workspace id it
// merely supplies.
//
// Pure over a `store.runTransaction(fn)` abstraction (Firestore or the
// in-memory store), so the exact same code path is tested without Firebase.

import { CLOUD_SCHEMA_VERSION } from "./cloudModel";

export const MEMBER_ROLE = Object.freeze({ OWNER: "owner", MEMBER: "member" });

export class WorkspaceBootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceBootstrapError";
    this.code = code;
  }
}

export const BOOTSTRAP_ERROR = Object.freeze({
  NOT_A_MEMBER: "not-a-member",
  BAD_USER_RECORD: "bad-user-record",
});

function randomWorkspaceId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `ws-${crypto.randomUUID()}`;
    }
  } catch {
    // fall through
  }
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * @param {{ runTransaction: (fn: (tx: { get: Function, set: Function }) => Promise<any>) => Promise<any>, timestamp: () => any }} store
 * @param {{ uid: string, newWorkspaceId?: () => string, workspaceName?: string }} options
 * @returns {Promise<{ workspaceId: string, role: string, created: boolean }>}
 */
export async function bootstrapWorkspace(store, { uid, newWorkspaceId = randomWorkspaceId, workspaceName = "My workspace" }) {
  if (typeof uid !== "string" || !uid) throw new WorkspaceBootstrapError(BOOTSTRAP_ERROR.BAD_USER_RECORD, "A uid is required");
  return store.runTransaction(async (tx) => {
    const userDoc = await tx.get(["users", uid]);
    const pointer = userDoc.exists ? userDoc.data.defaultWorkspaceId : null;

    if (typeof pointer === "string" && pointer) {
      const member = await tx.get(["workspaces", pointer, "members", uid]);
      if (member.exists) {
        return { workspaceId: pointer, role: String(member.data.role || MEMBER_ROLE.MEMBER), created: false };
      }
      const workspace = await tx.get(["workspaces", pointer]);
      if (!workspace.exists || workspace.data.ownerUid !== uid) {
        throw new WorkspaceBootstrapError(
          BOOTSTRAP_ERROR.NOT_A_MEMBER,
          "Your account points at a workspace you are not a member of."
        );
      }
      // Partial bootstrap repair: the workspace is ours, the membership is missing.
      tx.set(["workspaces", pointer, "members", uid], {
        uid,
        role: MEMBER_ROLE.OWNER,
        addedAt: store.timestamp(),
        addedBy: uid,
      });
      return { workspaceId: pointer, role: MEMBER_ROLE.OWNER, created: false, repaired: true };
    }

    if (userDoc.exists && pointer !== null && pointer !== undefined) {
      throw new WorkspaceBootstrapError(BOOTSTRAP_ERROR.BAD_USER_RECORD, "Your account record is unreadable.");
    }

    const workspaceId = newWorkspaceId();
    const now = store.timestamp();
    tx.set(["workspaces", workspaceId], {
      id: workspaceId,
      name: workspaceName,
      ownerUid: uid,
      schemaVersion: CLOUD_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    tx.set(["workspaces", workspaceId, "members", uid], {
      uid,
      role: MEMBER_ROLE.OWNER,
      addedAt: now,
      addedBy: uid,
    });
    tx.set(["users", uid], {
      uid,
      defaultWorkspaceId: workspaceId,
      createdAt: userDoc.exists && userDoc.data.createdAt ? userDoc.data.createdAt : now,
      updatedAt: now,
    });
    return { workspaceId, role: MEMBER_ROLE.OWNER, created: true };
  });
}
