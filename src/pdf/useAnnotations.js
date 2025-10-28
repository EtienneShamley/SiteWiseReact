// src/pdf/useAnnotations.js
import { useCallback, useMemo, useRef, useState } from "react";
import { cloneAnn } from "./annotationSchema";

export function useAnnotations(initial = []) {
  const [items, setItems] = useState(() => initial.slice());
  const [activeId, setActiveId] = useState(null);
  const [hoverId, setHoverId] = useState(null);
  const historyRef = useRef({ past: [], future: [] });

  const active = useMemo(() => items.find(i => i.id === activeId) || null, [items, activeId]);

  const commit = useCallback((next) => {
    historyRef.current.past.push(items);
    historyRef.current.future = [];
    setItems(next);
  }, [items]);

  const add = useCallback((ann) => {
    commit([...items, ann]);
    setActiveId(ann.id);
  }, [items, commit]);

  const remove = useCallback((id) => {
    commit(items.filter(i => i.id !== id));
    if (activeId === id) setActiveId(null);
  }, [items, commit, activeId]);

  const update = useCallback((id, mut) => {
    const next = items.map(i => (i.id === id ? mut(cloneAnn(i)) : i));
    commit(next);
  }, [items, commit]);

  const bringForward = useCallback((id) => {
    const idx = items.findIndex(i => i.id === id);
    if (idx < 0 || idx === items.length - 1) return;
    const next = items.slice();
    const [ann] = next.splice(idx, 1);
    next.splice(idx + 1, 0, ann);
    commit(next);
  }, [items, commit]);

  const sendBackward = useCallback((id) => {
    const idx = items.findIndex(i => i.id === id);
    if (idx <= 0) return;
    const next = items.slice();
    const [ann] = next.splice(idx, 1);
    next.splice(idx - 1, 0, ann);
    commit(next);
  }, [items, commit]);

  const lockToggle = useCallback((id) => {
    update(id, (a) => { a.locked = !a.locked; a.updatedAt = Date.now(); return a; });
  }, [update]);

  const duplicate = useCallback((id) => {
    const src = items.find(i => i.id === id);
    if (!src) return;
    const copy = { ...cloneAnn(src), id: src.id + "_copy", x: (src.x ?? src.x1) + 16, y: (src.y ?? src.y1) + 16, x1: (src.x1 ?? src.x) + 16, y1: (src.y1 ?? src.y) + 16 };
    commit([...items, copy]);
    setActiveId(copy.id);
  }, [items, commit]);

  const undo = () => {
    const { past, future } = historyRef.current;
    if (!past.length) return;
    const prev = past.pop();
    future.unshift(items);
    setItems(prev);
  };
  const redo = () => {
    const { past, future } = historyRef.current;
    if (!future.length) return;
    const next = future.shift();
    past.push(items);
    setItems(next);
  };

  const serialize = () => JSON.stringify(items);
  const load = (json) => {
    try {
      const arr = JSON.parse(json || "[]");
      setItems(Array.isArray(arr) ? arr : []);
      setActiveId(null);
      historyRef.current = { past: [], future: [] };
    } catch {}
  };

  return {
    items, active, activeId, setActiveId, hoverId, setHoverId,
    add, remove, update, bringForward, sendBackward, lockToggle, duplicate,
    undo, redo, serialize, load
  };
}
