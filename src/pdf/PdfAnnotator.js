// src/pdf/PdfAnnotator.js
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useCallback,
} from "react";
import ReactDOM from "react-dom";

/* -------------------------------------------------------------------------- */
/* Tools & helpers                                                            */
/* -------------------------------------------------------------------------- */

const TOOL = {
  SELECT: "select",
  PAN: "pan",
  HIGHLIGHT: "highlight",
  UNDERLINE: "underline",
  STRIKE: "strike",
  TYPEWRITER: "typewriter",
  TEXTBOX: "textbox",
  CALLOUT: "callout",
  STICKY: "sticky",
  ARROW: "arrow",
  POLYLINE: "polyline",
};

const STYLE_MEMORY = {
  [TOOL.HIGHLIGHT]: { color: "#FFF59D", opacity: 0.35, thickness: 22 },
  [TOOL.UNDERLINE]: { stroke: "#1976D2", strokeWidth: 3, thickness: 3 },
  [TOOL.STRIKE]: { stroke: "#E53935", strokeWidth: 3, thickness: 3 },
  [TOOL.TEXTBOX]: {
    textColor: "#111111",
    fontSize: 14,
    stroke: "#333333",
    strokeWidth: 2,
    fill: "transparent",
  },
  [TOOL.TYPEWRITER]: { textColor: "#111111", fontSize: 14 },
  [TOOL.CALLOUT]: {
    textColor: "#111111",
    fontSize: 14,
    stroke: "#333333",
    strokeWidth: 2,
    fill: "transparent",
  },
  [TOOL.ARROW]: { stroke: "#333333", strokeWidth: 2, head: "single" },
  [TOOL.POLYLINE]: { stroke: "#333333", strokeWidth: 2 },
};

const makeId = () => "a_" + Math.random().toString(36).slice(2, 10);
const clone = (x) => JSON.parse(JSON.stringify(x));
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const angleDeg = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

/* -------------------------------------------------------------------------- */
/* PdfAnnotator                                                               */
/* -------------------------------------------------------------------------- */

export default forwardRef(function PdfAnnotator(
  { renderedPages, pageRefs, scale, activeTool },
  ref
) {
  const [items, setItems] = useState([]);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const [activeId, setActiveId] = useState(null);

  // Tool arming and style panel state
  const [armed, setArmed] = useState(false);
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [toolPanelPage, setToolPanelPage] = useState(null);
  const [toolStyle, setToolStyle] = useState(getInitialStyle(activeTool));

  // Sticky note bubble control
  const [openStickyId, setOpenStickyId] = useState(null);

  // History: past/future snapshots + batched drag
  const history = useRef({
    past: [],
    future: [],
    batchActive: false,
    baseline: null,
  });

  const write = (next) => {
    setItems(next);
    itemsRef.current = next;
  };

  function startBatch() {
    if (!history.current.batchActive) {
      history.current.batchActive = true;
      history.current.baseline = clone(itemsRef.current);
    }
  }
  function endBatch() {
    if (!history.current.batchActive) return;
    history.current.past.push(history.current.baseline);
    history.current.future = [];
    history.current.batchActive = false;
    history.current.baseline = null;
  }

  const undo = useCallback(() => {
    const h = history.current;
    if (!h.past.length) return;
    const prev = h.past.pop();
    h.future.unshift(itemsRef.current);
    write(prev);
    setActiveId(null);
  }, []);

  const redo = useCallback(() => {
    const h = history.current;
    if (!h.future.length) return;
    const next = h.future.shift();
    h.past.push(itemsRef.current);
    write(next);
    setActiveId(null);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      serialize: () => JSON.stringify(itemsRef.current),
      load: (json) => {
        try {
          const arr = JSON.parse(json || "[]");
          write(Array.isArray(arr) ? arr : []);
          history.current = { past: [], future: [], batchActive: false, baseline: null };
          setActiveId(null);
        } catch {}
      },
      undo,
      redo,
    }),
    [undo, redo]
  );

  // When tool changes: reset UI, open options, arm after close
  useEffect(() => {
    setActiveId(null);
    setOpenStickyId(null);
    setToolStyle(getInitialStyle(activeTool));
    const first = renderedPages[0]?.pageNo ?? null;
    setToolPanelPage(first);

    if (activeTool && activeTool !== TOOL.SELECT && activeTool !== TOOL.PAN) {
      setToolPanelOpen(true);
      setArmed(false);
    } else {
      setToolPanelOpen(false);
      setArmed(false);
    }
  }, [activeTool, renderedPages]);

  return (
    <>
      {renderedPages.map((p) => {
        const container = pageRefs?.[p.pageNo];
        if (!container) return null;
        return ReactDOM.createPortal(
          <PageOverlay
            key={p.pageNo}
            page={p}
            itemsRef={itemsRef}
            write={write}
            startBatch={startBatch}
            endBatch={endBatch}
            activeId={activeId}
            setActiveId={setActiveId}
            tool={activeTool}
            armed={armed}
            setArmed={setArmed}
            toolStyle={toolStyle}
            openStickyId={openStickyId}
            setOpenStickyId={setOpenStickyId}
          />,
          container
        );
      })}

      {renderedPages[0] &&
        pageRefs?.[renderedPages[0].pageNo] &&
        ReactDOM.createPortal(
          <div
            className="absolute z-20"
            style={{ right: 8, top: 8, display: "flex", gap: 6 }}
          >
            <button
              className="text-xs px-2 py-1 border rounded bg-white dark:bg-[#1b1b1b]"
              onClick={undo}
              title="Undo (Cmd/Ctrl+Z)"
            >
              Undo
            </button>
            <button
              className="text-xs px-2 py-1 border rounded bg-white dark:bg-[#1b1b1b]"
              onClick={redo}
              title="Redo (Cmd/Ctrl+Y)"
            >
              Redo
            </button>
          </div>,
          pageRefs[renderedPages[0].pageNo]
        )}

      {toolPanelOpen &&
        toolPanelPage &&
        pageRefs?.[toolPanelPage] &&
        ReactDOM.createPortal(
          <ToolOptionsPanel
            tool={activeTool}
            styleState={toolStyle}
            setStyleState={setToolStyle}
            onClose={() => {
              STYLE_MEMORY[activeTool] = { ...toolStyle };
              setToolPanelOpen(false);
              setArmed(true); // user can now draw/insert
            }}
            onCancel={() => {
              setToolPanelOpen(false);
              setArmed(false);
            }}
          />,
          pageRefs[toolPanelPage]
        )}
    </>
  );
});

/* -------------------------------------------------------------------------- */
/* PageOverlay                                                                */
/* -------------------------------------------------------------------------- */

function PageOverlay({
  page,
  itemsRef,
  write,
  startBatch,
  endBatch,
  activeId,
  setActiveId,
  tool,
  armed,
  setArmed,
  toolStyle,
  openStickyId,
  setOpenStickyId,
}) {
  const svgRef = useRef(null);
  const drag = useRef(null);
  const holdTimer = useRef(null);

  // Arrow marker once
  useEffect(() => {
    if (!svgRef.current) return;
    if (svgRef.current.querySelector("#arrow-defs")) return;
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.setAttribute("id", "arrow-defs");
    const m = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    m.setAttribute("id", "arrow-head");
    m.setAttribute("viewBox", "0 0 10 10");
    m.setAttribute("refX", "10");
    m.setAttribute("refY", "5");
    m.setAttribute("markerWidth", "6");
    m.setAttribute("markerHeight", "6");
    m.setAttribute("orient", "auto-start-reverse");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    path.setAttribute("fill", "currentColor");
    m.appendChild(path);
    defs.appendChild(m);
    svgRef.current.appendChild(defs);
  }, []);

  const getLocal = (evt) => {
    const rect = svgRef.current.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  };

  function attachGlobalDrag() {
    window.addEventListener("mousemove", onGlobalMove);
    window.addEventListener("mouseup", onGlobalUp);
  }
  function detachGlobalDrag() {
    window.removeEventListener("mousemove", onGlobalMove);
    window.removeEventListener("mouseup", onGlobalUp);
  }

  /* --------------------------------- Create -------------------------------- */

  // NEW: marks defined by endpoints (x0,y0) -> (x1,y1) so rotation is centered and stable
  function newMark(p0, kind) {
    const id = makeId();
    const thickness =
      kind === TOOL.HIGHLIGHT
        ? toolStyle.thickness ?? 22
        : toolStyle.thickness ?? toolStyle.strokeWidth ?? 3;

    const a = {
      id,
      page: page.pageNo,
      type: kind,
      x0: p0.x,
      y0: p0.y,
      x1: p0.x,
      y1: p0.y,
      thickness,
      // optional visual props
      fill: kind === TOOL.HIGHLIGHT ? (toolStyle.color || "#FFF59D") : undefined,
      opacity: kind === TOOL.HIGHLIGHT ? (toolStyle.opacity ?? 0.35) : undefined,
      stroke: kind !== TOOL.HIGHLIGHT ? (toolStyle.stroke || "#333333") : undefined,
      strokeWidth: kind !== TOOL.HIGHLIGHT ? (toolStyle.strokeWidth || 3) : undefined,
      angleSnap: null, // when user holds, we store snapped angle here
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
    drag.current = { mode: "mark", id, p0 };
    // hold to snap every ~2s
    holdTimer.current = window.setTimeout(() => {
      const cur = itemsRef.current;
      const me = cur.find((i) => i.id === id);
      if (!me) return;
      const ang = angleDeg({ x: me.x0, y: me.y0 }, { x: me.x1, y: me.y1 });
      const snapped = Math.round(ang / 15) * 15;
      write(cur.map((it) => (it.id === id ? { ...it, angleSnap: snapped } : it)));
    }, 2000);
  }

  function newTextbox(p0, kind = TOOL.TEXTBOX) {
    const id = makeId();
    const a = {
      id,
      page: page.pageNo,
      type: kind,
      x: p0.x,
      y: p0.y,
      w: 2,
      h: 2,
      text: "",
      textColor: toolStyle.textColor || "#111111",
      fontSize: toolStyle.fontSize || 14,
      fontFamily:
        toolStyle.fontFamily ||
        "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      stroke: toolStyle.stroke || "#333333",
      strokeWidth: toolStyle.strokeWidth || 2,
      fill: toolStyle.fill ?? "transparent",
      corner: 8,
      editing: false,
      ...(kind === TOOL.CALLOUT ? { leader: { x: p0.x - 40, y: p0.y - 20 } } : {}),
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
    drag.current = { mode: "textbox-new", id, x0: p0.x, y0: p0.y };
  }

  function newTypewriter(p0) {
    const id = makeId();
    const a = {
      id,
      page: page.pageNo,
      type: TOOL.TYPEWRITER,
      x: p0.x,
      y: p0.y,
      text: "",
      textColor: toolStyle.textColor || "#111111",
      fontSize: toolStyle.fontSize || 14,
      fontFamily:
        toolStyle.fontFamily ||
        "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      editing: true,
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
  }

  function newArrow(p0) {
    const id = makeId();
    const a = {
      id,
      page: page.pageNo,
      type: TOOL.ARROW,
      x1: p0.x - 30,
      y1: p0.y - 10,
      x2: p0.x + 30,
      y2: p0.y + 10,
      stroke: toolStyle.stroke || "#333333",
      strokeWidth: toolStyle.strokeWidth || 2,
      head: toolStyle.head || "single",
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
    drag.current = { mode: "arrow-end", id, which: "end2" };
  }

  function newSticky(p0) {
    const id = makeId();
    const a = {
      id,
      page: page.pageNo,
      type: TOOL.STICKY,
      x: p0.x,
      y: p0.y,
      color: "#FFE082",
      note: "",
      open: true,
    };
    startBatch();
    write([...itemsRef.current, a]);
    setActiveId(id);
    setOpenStickyId(id);
  }

  /* --------------------------------- Events -------------------------------- */

  function onSvgDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = getLocal(e);

    if (!armed || tool === TOOL.SELECT || tool === TOOL.PAN) {
      if (e.target === svgRef.current) setActiveId(null);
      return;
    }

    if (tool === TOOL.HIGHLIGHT || tool === TOOL.UNDERLINE || tool === TOOL.STRIKE) {
      newMark(p, tool);
      attachGlobalDrag();
      return;
    }
    if (tool === TOOL.TEXTBOX || tool === TOOL.CALLOUT) {
      newTextbox(p, tool);
      attachGlobalDrag();
      return;
    }
    if (tool === TOOL.TYPEWRITER) {
      newTypewriter(p);
      return;
    }
    if (tool === TOOL.ARROW) {
      newArrow(p);
      attachGlobalDrag();
      return;
    }
    if (tool === TOOL.STICKY) {
      newSticky(p);
      return;
    }
  }

  function onGlobalMove(e) {
    const d = drag.current;
    if (!d) return;
    const p = getLocal(e);

    const cur = itemsRef.current;
    const idx = cur.findIndex((i) => i.id === d.id);
    if (idx < 0) return;
    const next = cur.slice();
    const a = clone(next[idx]);

    if (d.mode === "mark") {
      a.x1 = p.x;
      a.y1 = p.y;
      a.angleSnap = a.angleSnap ?? null; // keep snap if already set
    } else if (d.mode === "textbox-new") {
      a.x = Math.min(d.x0, p.x);
      a.y = Math.min(d.y0, p.y);
      a.w = Math.max(10, Math.abs(p.x - d.x0));
      a.h = Math.max(10, Math.abs(p.y - d.y0));
    } else if (d.mode === "move-box") {
      a.x = p.x - d.dx;
      a.y = p.y - d.dy;
    } else if (d.mode === "rotate-box") {
      const cx = a.x + a.w / 2;
      const cy = a.y + a.h / 2;
      a.rotate = angleDeg({ x: cx, y: cy }, p);
    } else if (d.mode === "move-text") {
      a.x = p.x - d.dx;
      a.y = p.y - d.dy;
    } else if (d.mode === "move-mark") {
      // translate both endpoints
      const dx = p.x - d.pStart.x;
      const dy = p.y - d.pStart.y;
      a.x0 = d.x0 + dx;
      a.y0 = d.y0 + dy;
      a.x1 = d.x1 + dx;
      a.y1 = d.y1 + dy;
    } else if (d.mode === "move-leader") {
      a.leader.x = p.x;
      a.leader.y = p.y;
    } else if (d.mode === "arrow-end" && a.type === TOOL.ARROW) {
      if (d.which === "end1") {
        a.x1 = p.x;
        a.y1 = p.y;
      } else {
        a.x2 = p.x;
        a.y2 = p.y;
      }
    }

    next[idx] = a;
    write(next);
  }

  function onGlobalUp() {
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    drag.current = null;
    detachGlobalDrag();
    endBatch();
  }

  /* -------------------------- Move/resize handlers ------------------------- */

  const startMove = (a, kind) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    setActiveId(a.id);
    startBatch();
    const p = getLocal(e);
    if (kind === "box") drag.current = { mode: "move-box", id: a.id, dx: p.x - a.x, dy: p.y - a.y };
    if (kind === "text") drag.current = { mode: "move-text", id: a.id, dx: p.x - a.x, dy: p.y - a.y };
    if (kind === "mark") {
      drag.current = {
        mode: "move-mark",
        id: a.id,
        pStart: p,
        x0: a.x0,
        y0: a.y0,
        x1: a.x1,
        y1: a.y1,
      };
    }
    attachGlobalDrag();
  };

  const startResizeSE = (a) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    setActiveId(a.id);
    startBatch();
    drag.current = { mode: "textbox-new", id: a.id, x0: a.x, y0: a.y };
    attachGlobalDrag();
  };

  const startRotate = (a) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    setActiveId(a.id);
    startBatch();
    drag.current = { mode: "rotate-box", id: a.id };
    attachGlobalDrag();
  };

  const startArrowEnd = (a, which) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    setActiveId(a.id);
    startBatch();
    drag.current = { mode: "arrow-end", id: a.id, which };
    attachGlobalDrag();
  };

  const startLeader = (a) => (e) => {
    e.stopPropagation();
    e.preventDefault();
    setActiveId(a.id);
    startBatch();
    drag.current = { mode: "move-leader", id: a.id };
    attachGlobalDrag();
  };

  /* --------------------------------- Render -------------------------------- */

  const cursor =
    tool === TOOL.PAN ? "grab" : tool === TOOL.SELECT ? "default" : armed ? "crosshair" : "default";

  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: page.w, height: page.h }}>
      <svg
        ref={svgRef}
        width={page.w}
        height={page.h}
        viewBox={`0 0 ${page.w} ${page.h}`}
        style={{ position: "absolute", left: 0, top: 0, cursor }}
        onMouseDown={onSvgDown}
      >
        <defs id="arrow-defs" />
        {itemsRef.current
          .filter((a) => a.page === page.pageNo)
          .map((a) => renderItem(a))}
      </svg>
    </div>
  );

  function renderItem(a) {
    switch (a.type) {
      case TOOL.TEXTBOX:
      case TOOL.CALLOUT:
        return renderTextbox(a);
      case TOOL.TYPEWRITER:
        return renderTypewriter(a);
      case TOOL.STICKY:
        return renderSticky(a);
      case TOOL.ARROW:
        return renderArrow(a);
      case TOOL.POLYLINE:
        return renderPolyline(a);
      case TOOL.HIGHLIGHT:
      case TOOL.UNDERLINE:
      case TOOL.STRIKE:
        return renderMark(a);
      default:
        return null;
    }
  }

  function renderTextbox(a) {
    const transform = a.rotate
      ? `rotate(${a.rotate} ${(a.x + a.w / 2)} ${(a.y + a.h / 2)})`
      : undefined;

    return (
      <g key={a.id} transform={transform}>
        {a.type === TOOL.CALLOUT && (
          <line
            x1={a.leader?.x ?? a.x - 20}
            y1={a.leader?.y ?? a.y - 20}
            x2={a.x}
            y2={a.y}
            stroke={a.stroke || "#333333"}
            strokeWidth={a.strokeWidth || 2}
            onMouseDown={startLeader(a)}
          />
        )}
        <rect
          x={a.x}
          y={a.y}
          width={a.w}
          height={a.h}
          rx={a.corner || 8}
          ry={a.corner || 8}
          fill={a.fill ?? "transparent"}
          stroke={a.stroke || "#333333"}
          strokeWidth={a.strokeWidth || 2}
          style={{ cursor: "move" }}
          onMouseDown={startMove(a, "box")}
          onClick={() => setActiveId(a.id)}
        />
        <foreignObject
          x={a.x + 6}
          y={a.y + 6}
          width={Math.max(20, a.w - 12)}
          height={Math.max(20, a.h - 12)}
        >
          <div
            dir="ltr"
            style={{
              width: "100%",
              height: "100%",
              outline: a.editing ? "1px dashed #bbb" : "none",
              background: "transparent",
              color: a.textColor || "#111111",
              fontSize: a.fontSize || 14,
              fontFamily:
                a.fontFamily ||
                "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
              textAlign: a.align || "left",
              lineHeight: 1.25,
              whiteSpace: "pre-wrap",
              direction: "ltr",
              unicodeBidi: "isolate",
              writingMode: "horizontal-tb",
            }}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onFocus={() => setActiveId(a.id)}
            onInput={(e) => {
              const cur = itemsRef.current;
              write(
                cur.map((it) =>
                  it.id === a.id ? { ...it, text: e.currentTarget.textContent } : it
                )
              );
            }}
            onKeyDown={(e) => {
              const mac = navigator.platform.toLowerCase().includes("mac");
              const ctrl = mac ? e.metaKey : e.ctrlKey;
              if ((ctrl && e.key === "Enter") || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                finishEdit(a.id);
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelIfEmpty(a.id);
              }
            }}
            onBlur={() => {
              finishEdit(a.id);
              cancelIfEmpty(a.id);
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {a.text || ""}
          </div>
        </foreignObject>

        {!a.editing && (
          <>
            <rect
              x={a.x + a.w - 6}
              y={a.y + a.h - 6}
              width={12}
              height={12}
              fill="#fff"
              stroke="#333"
              onMouseDown={startResizeSE(a)}
            />
            <circle
              cx={a.x + a.w / 2}
              cy={a.y - 24}
              r={6}
              fill="#fff"
              stroke="#333"
              onMouseDown={startRotate(a)}
            />
            <line
              x1={a.x + a.w / 2}
              y1={a.y - 24}
              x2={a.x + a.w / 2}
              y2={a.y}
              stroke="#333"
            />
          </>
        )}
      </g>
    );
  }

  function finishEdit(id) {
    startBatch();
    const cur = itemsRef.current;
    write(cur.map((x) => (x.id === id ? { ...x, editing: false } : x)));
    endBatch();
    setActiveId(id);
  }

  function cancelIfEmpty(id) {
    const cur = itemsRef.current;
    const it = cur.find((x) => x.id === id);
    if (!it) return;
    const content = (it.text ?? it.note ?? "").trim();
    if (content === "") {
      startBatch();
      write(cur.filter((x) => x.id !== id));
      endBatch();
      setActiveId(null);
    }
  }

  function renderTypewriter(a) {
    return (
      <g key={a.id}>
        <foreignObject
          x={a.x}
          y={a.y - (a.fontSize || 14)}
          width={Math.max(160, 260)}
          height={Math.max(28, 40)}
        >
          <div
            dir="ltr"
            style={{
              minHeight: 20,
              outline: a.editing ? "1px dashed #bbb" : "none",
              background: "transparent",
              color: a.textColor || "#111111",
              fontSize: a.fontSize || 14,
              fontFamily:
                a.fontFamily ||
                "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
              lineHeight: 1.2,
              padding: "2px 4px",
              cursor: "text",
              direction: "ltr",
              unicodeBidi: "isolate",
              writingMode: "horizontal-tb",
              whiteSpace: "pre",
            }}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onFocus={() => setActiveId(a.id)}
            onInput={(e) => {
              const cur = itemsRef.current;
              write(
                cur.map((it) =>
                  it.id === a.id ? { ...it, text: e.currentTarget.textContent } : it
                )
              );
            }}
            onKeyDown={(e) => {
              const mac = navigator.platform.toLowerCase().includes("mac");
              const ctrl = mac ? e.metaKey : e.ctrlKey;
              if ((ctrl && e.key === "Enter") || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                finishEdit(a.id);
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelIfEmpty(a.id);
              }
            }}
            onBlur={() => {
              finishEdit(a.id);
              cancelIfEmpty(a.id);
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {a.text || ""}
          </div>
        </foreignObject>

        {!a.editing && (
          <rect
            x={a.x - 4}
            y={a.y - (a.fontSize || 14) - 4}
            width={Math.max(160, 260)}
            height={Math.max(28, 40)}
            fill="transparent"
            onMouseDown={startMove(a, "text")}
            onClick={() => setActiveId(a.id)}
          />
        )}
      </g>
    );
  }

  function renderArrow(a) {
    return (
      <g key={a.id} onMouseDown={(e) => e.stopPropagation()}>
        <line
          x1={a.x1}
          y1={a.y1}
          x2={a.x2}
          y2={a.y2}
          stroke={a.stroke || "#333333"}
          strokeWidth={a.strokeWidth || 2}
          markerEnd={
            a.head === "single" || a.head === "double" ? "url(#arrow-head)" : undefined
          }
          markerStart={a.head === "double" ? "url(#arrow-head)" : undefined}
          onClick={() => setActiveId(a.id)}
        />
        {activeId === a.id && (
          <>
            <circle
              cx={a.x1}
              cy={a.y1}
              r={6}
              fill="#fff"
              stroke="#333"
              onMouseDown={startArrowEnd(a, "end1")}
            />
            <circle
              cx={a.x2}
              cy={a.y2}
              r={6}
              fill="#fff"
              stroke="#333"
              onMouseDown={startArrowEnd(a, "end2")}
            />
          </>
        )}
      </g>
    );
  }

  function renderPolyline(a) {
    const d = (a.pts || []).map((pt) => `${pt.x},${pt.y}`).join(" ");
    return (
      <g key={a.id} onMouseDown={(e) => e.stopPropagation()}>
        <polyline
          points={d}
          fill="none"
          stroke={a.stroke || "#333333"}
          strokeWidth={a.strokeWidth || 2}
          onClick={() => setActiveId(a.id)}
        />
      </g>
    );
  }

  // NEW: center-anchored rotated rect for marks (uses endpoints)
  function renderMark(a) {
    const p0 = { x: a.x0, y: a.y0 };
    const p1 = { x: a.x1, y: a.y1 };
    const w = Math.max(1, dist(p0, p1));
    const h =
      a.type === TOOL.HIGHLIGHT
        ? Math.max(1, a.thickness ?? 22)
        : Math.max(1, a.thickness ?? a.strokeWidth ?? 3);
    const cx = (a.x0 + a.x1) / 2;
    const cy = (a.y0 + a.y1) / 2;
    const ang = a.angleSnap != null ? a.angleSnap : angleDeg(p0, p1);

    const x = cx - w / 2;
    const y =
      a.type === TOOL.HIGHLIGHT
        ? cy - h / 2
        : cy - h / 2; // underline/strike rendered as thin rotated rect too

    const commonProps = {
      transform: `rotate(${ang} ${cx} ${cy})`,
      onMouseDown: startMove(a, "mark"),
      onClick: () => setActiveId(a.id),
    };

    if (a.type === TOOL.HIGHLIGHT) {
      return (
        <rect
          key={a.id}
          x={x}
          y={y}
          width={w}
          height={h}
          fill={a.fill || "#FFF59D"}
          fillOpacity={a.opacity ?? 0.35}
          {...commonProps}
        />
      );
    }
    // UNDERLINE / STRIKE → thin filled rect
    return (
      <rect
        key={a.id}
        x={x}
        y={y}
        width={w}
        height={h}
        fill={a.stroke || "#333333"}
        {...commonProps}
      />
    );
  }

  function renderSticky(a) {
    const isOpen = openStickyId === a.id || a.open;
    return (
      <g key={a.id} onMouseDown={(e) => e.stopPropagation()}>
        <rect
          x={a.x}
          y={a.y}
          width={18}
          height={18}
          fill={a.color || "#FFE082"}
          stroke="#333"
          onMouseDown={startMove(a, "mark")}
          onClick={() => {
            setActiveId(a.id);
            setOpenStickyId(a.id);
          }}
        />
        {isOpen && (
          <foreignObject x={a.x + 22} y={a.y - 6} width={240} height={160}>
            <div
              className="shadow border rounded"
              style={{
                background: "#fff",
                padding: 8,
                width: 240,
                height: 160,
                fontSize: 12,
                color: "#111",
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="text-xs mb-1">Sticky note</div>
              <textarea
                dir="ltr"
                value={a.note || ""}
                onChange={(e) => {
                  const cur = itemsRef.current;
                  write(
                    cur.map((it) =>
                      it.id === a.id ? { ...it, note: e.target.value } : it
                    )
                  );
                }}
                onBlur={() => {
                  startBatch();
                  write(itemsRef.current.slice());
                  endBatch();
                }}
                style={{
                  width: "100%",
                  height: 92,
                  border: "1px solid #ccc",
                  borderRadius: 6,
                  padding: 6,
                  background: "#fff",
                  color: "#111",
                }}
              />
              <div className="mt-2 flex justify-between">
                <button
                  className="text-xs px-2 py-1 border rounded"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenStickyId(null);
                  }}
                >
                  Close
                </button>
                <button
                  className="text-xs px-2 py-1 border rounded"
                  onClick={(e) => {
                    e.stopPropagation();
                    startBatch();
                    write(itemsRef.current.filter((it) => it.id !== a.id));
                    endBatch();
                    setActiveId(null);
                    setOpenStickyId(null);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </foreignObject>
        )}
      </g>
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Tool Options Panel                                                         */
/* -------------------------------------------------------------------------- */

function getInitialStyle(tool) {
  const mem = STYLE_MEMORY[tool];
  return mem ? { ...mem } : {};
}

function ToolOptionsPanel({ tool, styleState, setStyleState, onClose, onCancel }) {
  const isMark =
    tool === TOOL.HIGHLIGHT || tool === TOOL.UNDERLINE || tool === TOOL.STRIKE;
  const isText =
    tool === TOOL.TEXTBOX || tool === TOOL.TYPEWRITER || tool === TOOL.CALLOUT;
  const isStroke =
    tool === TOOL.ARROW ||
    tool === TOOL.POLYLINE ||
    tool === TOOL.CALLOUT ||
    tool === TOOL.TEXTBOX ||
    tool === TOOL.UNDERLINE ||
    tool === TOOL.STRIKE;

  const colorChoices = [
    "#111111",
    "#333333",
    "#9E9E9E",
    "#FFF59D",
    "#FFECB3",
    "#FFD54F",
    "#C8E6C9",
    "#A5D6A7",
    "#BBDEFB",
    "#90CAF9",
    "#F48FB1",
    "#E53935",
    "#1976D2",
  ];

  const selectedColor =
    isMark && tool === TOOL.HIGHLIGHT
      ? styleState.color
      : isText
      ? styleState.textColor
      : styleState.stroke;

  return (
    <div
      className="absolute z-30 px-3 py-2 bg-white dark:bg-[#1b1b1b] border rounded shadow text-xs"
      style={{ left: 8, top: 8, minWidth: 300 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="font-medium opacity-80">Tool Options — {tool}</div>
        <div className="flex gap-2">
          <button className="px-2 py-0.5 border rounded" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="px-2 py-0.5 border rounded bg-blue-50 dark:bg-blue-900/30"
            onClick={onClose}
          >
            Close & Arm
          </button>
        </div>
      </div>

      {/* Color swatches (soft outline for selected) */}
      <div className="mb-2">
        <div className="mb-1">Color</div>
        <div className="flex flex-wrap gap-1">
          {colorChoices.map((c) => (
            <button
              key={c}
              className="w-6 h-6 rounded"
              style={{
                background: c,
                border:
                  selectedColor === c ? "2px solid rgba(59,130,246,0.6)" : "1px solid #ccc",
                boxShadow:
                  selectedColor === c ? "0 0 0 2px rgba(59,130,246,0.25)" : "none",
              }}
              title={c}
              onClick={() => {
                if (tool === TOOL.HIGHLIGHT) setStyleState({ ...styleState, color: c });
                else if (isText) setStyleState({ ...styleState, textColor: c });
                else setStyleState({ ...styleState, stroke: c });
              }}
            />
          ))}
        </div>
      </div>

      {tool === TOOL.HIGHLIGHT && (
        <>
          <label className="block mb-1">
            Opacity: {(styleState.opacity ?? 0.35).toFixed(2)}
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={styleState.opacity ?? 0.35}
            onChange={(e) =>
              setStyleState({ ...styleState, opacity: Number(e.target.value) })
            }
            className="w-full mb-2"
          />
          <label className="block mb-1">
            Thickness: {Math.round(styleState.thickness ?? 22)} px
          </label>
          <input
            type="range"
            min="6"
            max="64"
            step="1"
            value={styleState.thickness ?? 22}
            onChange={(e) =>
              setStyleState({ ...styleState, thickness: Number(e.target.value) })
            }
            className="w-full"
          />
        </>
      )}

      {isStroke && (
        <>
          <label className="block mb-1">
            Stroke width: {styleState.strokeWidth ?? 2}px
          </label>
          <input
            type="range"
            min="1"
            max="12"
            step="1"
            value={styleState.strokeWidth ?? 2}
            onChange={(e) =>
              setStyleState({
                ...styleState,
                strokeWidth: Number(e.target.value),
              })
            }
            className="w-full mb-2"
          />
        </>
      )}

      {isText && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <div className="mb-1">Font size</div>
            <input
              className="w-full px-2 py-1 border rounded bg-white dark:bg-[#111]"
              value={styleState.fontSize ?? 14}
              onChange={(e) =>
                setStyleState({
                  ...styleState,
                  fontSize: Number(e.target.value) || 14,
                })
              }
            />
          </label>
          <label className="block">
            <div className="mb-1">Fill (textbox)</div>
            <input
              className="w-full px-2 py-1 border rounded bg-white dark:bg-[#111]"
              value={styleState.fill ?? "transparent"}
              onChange={(e) =>
                setStyleState({ ...styleState, fill: e.target.value })
              }
              placeholder="transparent"
            />
          </label>
        </div>
      )}

      {tool === TOOL.ARROW && (
        <div className="mt-2">
          <div className="mb-1">Head</div>
          <select
            className="px-2 py-1 border rounded bg-white dark:bg-[#111]"
            value={styleState.head || "single"}
            onChange={(e) =>
              setStyleState({ ...styleState, head: e.target.value })
            }
          >
            <option value="none">none</option>
            <option value="single">single</option>
            <option value="double">double</option>
          </select>
        </div>
      )}
    </div>
  );
}
