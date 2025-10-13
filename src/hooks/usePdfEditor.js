// src/hooks/usePdfEditor.js
import { useCallback, useMemo, useReducer } from "react";

/**
 * Annotation model per page:
 * - { type: 'highlight', x, y, w, h }           // coords in PDF pixels at renderScale=1
 * - { type: 'text', x, y, text, fontSize = 14 } // top-left anchor
 */

function reducer(state, action) {
  switch (action.type) {
    case "LOAD_DOC":
      return { ...state, docName: action.docName || null, pageCount: action.pageCount || 0, annotations: {}, history: [], future: [] };
    case "SET_PAGE_COUNT":
      return { ...state, pageCount: action.pageCount || 0 };
    case "ADD_ANN": {
      const { page, ann } = action;
      const next = { ...(state.annotations || {}) };
      next[page] = [...(next[page] || []), ann];
      return { ...state, annotations: next, history: [...state.history, state], future: [] };
    }
    case "DELETE_LAST": {
      const { page } = action;
      const curr = state.annotations?.[page] || [];
      if (!curr.length) return state;
      const next = { ...(state.annotations || {}) };
      next[page] = curr.slice(0, -1);
      return { ...state, annotations: next, history: [...state.history, state], future: [] };
    }
    case "UNDO": {
      if (!state.history.length) return state;
      const prev = state.history[state.history.length - 1];
      return { ...prev, future: [state, ...state.future], history: state.history.slice(0, -1) };
    }
    case "REDO": {
      if (!state.future.length) return state;
      const next = state.future[0];
      return { ...next, history: [...state.history, state], future: state.future.slice(1) };
    }
    case "RESET_ANN":
      return { ...state, annotations: {}, history: [], future: [] };
    default:
      return state;
  }
}

export function usePdfEditor() {
  const [state, dispatch] = useReducer(reducer, {
    docName: null,
    pageCount: 0,
    annotations: {},
    history: [],
    future: [],
  });

  const addHighlight = useCallback((page, rect) => {
    dispatch({ type: "ADD_ANN", page, ann: { type: "highlight", ...rect } });
  }, []);
  const addText = useCallback((page, payload) => {
    dispatch({ type: "ADD_ANN", page, ann: { type: "text", ...payload } });
  }, []);
  const deleteLast = useCallback((page) => dispatch({ type: "DELETE_LAST", page }), []);
  const undo = useCallback(() => dispatch({ type: "UNDO" }), []);
  const redo = useCallback(() => dispatch({ type: "REDO" }), []);
  const reset = useCallback(() => dispatch({ type: "RESET_ANN" }), []);
  const loadDocMeta = useCallback((name, pageCount) => dispatch({ type: "LOAD_DOC", docName: name, pageCount }), []);

  const canUndo = useMemo(() => state.history.length > 0, [state.history]);
  const canRedo = useMemo(() => state.future.length > 0, [state.future]);

  return {
    state,
    addHighlight,
    addText,
    deleteLast,
    undo,
    redo,
    reset,
    loadDocMeta,
    canUndo,
    canRedo,
  };
}
