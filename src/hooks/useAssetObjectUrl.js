// src/hooks/useAssetObjectUrl.js
//
// Resolves an IndexedDB asset id to a live object URL for <img src>, and owns
// that URL's lifecycle so components never leak or persist blob: URLs:
//   - creates an object URL only when there is an asset id to resolve
//   - revokes the previous URL when the asset id changes
//   - revokes the URL on unmount
//   - does not recreate the URL on every render (keyed on assetId)
//   - reports loading / ready / missing / error so callers can show a safe
//     placeholder instead of a broken image
//
// Shared by the Template Builder and the note renderer, which need identical
// behavior. blob: URLs are transient and are never persisted anywhere.
//
// The read itself goes through the shared asset read boundary
// (src/lib/assetReader.js), so the several images of one note that reference
// the same photo share one read instead of each making its own, and so the
// cross-device read added in a later phase arrives here without this hook
// changing. The reported statuses are the shared vocabulary's — the same four
// strings this hook has always returned; nothing here can report
// "downloading", because in this phase nothing downloads.
import { useEffect, useState } from "react";
import { ASSET_READ_STATE, loadAsset } from "../lib/assetReader";

export default function useAssetObjectUrl(assetId) {
  const [state, setState] = useState(() => ({
    url: null,
    status: assetId ? ASSET_READ_STATE.LOADING : ASSET_READ_STATE.IDLE,
  }));

  useEffect(() => {
    if (!assetId) {
      setState({ url: null, status: ASSET_READ_STATE.IDLE });
      return undefined;
    }

    let cancelled = false;
    let objectUrl = null;
    setState({ url: null, status: ASSET_READ_STATE.LOADING });

    loadAsset(assetId)
      .then((asset) => {
        if (cancelled) return;
        if (!asset || !asset.blob) {
          setState({ url: null, status: ASSET_READ_STATE.MISSING });
          return;
        }
        objectUrl = URL.createObjectURL(asset.blob);
        setState({ url: objectUrl, status: ASSET_READ_STATE.READY });
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, status: ASSET_READ_STATE.ERROR });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);

  return state;
}
