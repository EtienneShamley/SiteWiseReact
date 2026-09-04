// src/hooks/useAssetObjectUrl.js
//
// Resolves an IndexedDB asset id to a live object URL for <img src>, and owns
// that URL's lifecycle so components never leak or persist blob: URLs:
//   - creates an object URL only when there is an asset id to resolve
//   - revokes the previous URL when the asset id changes
//   - revokes the URL on unmount
//   - does not recreate the URL on every render (keyed on assetId)
//   - reports the shared read state so callers can show a safe, accurate
//     placeholder instead of a broken image
//
// Shared by the Template Builder and the note renderer, which need identical
// behavior. blob: URLs are transient and are never persisted anywhere.
//
// The read itself goes through the shared asset read boundary
// (src/lib/assetReader.js), so the several images of one note that reference
// the same photo share one read — and, when the bytes have to come from the
// workspace's cloud copy, ONE download.
//
// WHAT PHASE 7.5 ADDED, and nothing more: the hook now reports the read's own
// state and code rather than collapsing everything that is not a hit into
// "missing", and exposes a `retry` for the states where trying again can
// genuinely change the answer. A LOCAL HIT IS UNCHANGED — same call, same
// cost, same `ready`, no network — and an asset that is simply not here in a
// local-only build still reports `missing`, exactly as before.
import { useCallback, useEffect, useState } from "react";
import { ASSET_READ_STATE, readAssetWithState } from "../lib/assetReader";

const idleState = { url: null, status: ASSET_READ_STATE.IDLE, code: null };

export default function useAssetObjectUrl(assetId) {
  const [state, setState] = useState(() =>
    assetId ? { url: null, status: ASSET_READ_STATE.LOADING, code: null } : idleState
  );
  // Bumped by `retry`; re-runs the effect, which is a genuinely fresh read:
  // the read boundary releases an in-flight entry when it settles, so there is
  // no cached failure to be served, and a remote read always resolves the
  // workspace's CURRENT asset metadata.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!assetId) {
      setState(idleState);
      return undefined;
    }

    let cancelled = false;
    let objectUrl = null;
    setState({ url: null, status: ASSET_READ_STATE.LOADING, code: null });

    readAssetWithState(assetId, {
      // Reported the moment a download actually starts — including to a
      // second image of the same photo that joined one already in flight.
      onState: (phase) => {
        if (cancelled) return;
        setState((prev) => (prev.url ? prev : { url: null, status: phase, code: null }));
      },
    })
      .then(({ state: status, record, code }) => {
        if (cancelled) return;
        if (status !== ASSET_READ_STATE.READY || !record || !record.blob) {
          setState({
            url: null,
            status: status === ASSET_READ_STATE.READY ? ASSET_READ_STATE.MISSING : status,
            code: code || null,
          });
          return;
        }
        objectUrl = URL.createObjectURL(record.blob);
        setState({ url: objectUrl, status: ASSET_READ_STATE.READY, code: null });
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, status: ASSET_READ_STATE.ERROR, code: null });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { url: state.url, status: state.status, code: state.code, retry };
}
