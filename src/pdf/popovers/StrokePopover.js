// src/pdf/popovers/StrokePopover.js
import React, { useState } from "react";

export default function StrokePopover({ color = "#333333", width = 2, dash = "", onChange }) {
  const [c, setC] = useState(color);
  const [w, setW] = useState(width);
  const [d, setD] = useState(dash);

  const push = () => onChange && onChange({ color: c, width: Number(w) || 1, dash: d });

  return (
    <div className="p-2 bg-white dark:bg-[#1b1b1b] border rounded shadow">
      <div className="text-xs mb-1">Stroke</div>
      <div className="flex items-center gap-2 mb-2">
        <input className="w-28 text-xs px-2 py-1 bg-white dark:bg-[#111] border rounded" value={c} onChange={e=>setC(e.target.value)} />
        <input className="w-16 text-xs px-2 py-1 bg-white dark:bg-[#111] border rounded" value={w} onChange={e=>setW(e.target.value)} />
        <select className="text-xs px-2 py-1 bg-white dark:bg-[#111] border rounded" value={d} onChange={e=>setD(e.target.value)}>
          <option value="">solid</option>
          <option value="4,2">dashed</option>
          <option value="1,2">dotted</option>
        </select>
      </div>
      <button className="text-xs px-2 py-1 border rounded" onClick={push}>Apply</button>
    </div>
  );
}
