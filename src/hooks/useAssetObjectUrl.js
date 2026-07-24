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
import { useEffect, useState } from "react";
import { getAsset } from "../lib/assetStorage";

export default function useAssetObjectUrl(assetId) {
  const [state, setState] = useState(() => ({
    url: null,
    status: assetId ? "loading" : "idle",
  }));

  useEffect(() => {
    if (!assetId) {
      setState({ url: null, status: "idle" });
      return undefined;
    }

    let cancelled = false;
    let objectUrl = null;
    setState({ url: null, status: "loading" });

    getAsset(assetId)
      .then((asset) => {
        if (cancelled) return;
        if (!asset || !asset.blob) {
          setState({ url: null, status: "missing" });
          return;
        }
        objectUrl = URL.createObjectURL(asset.blob);
        setState({ url: objectUrl, status: "ready" });
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, status: "error" });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);

  return state;
}
