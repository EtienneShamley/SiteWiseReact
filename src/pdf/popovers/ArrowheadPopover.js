// src/pdf/popovers/ArrowheadPopover.js
import React, { useState } from "react";

export default function ArrowheadPopover({ head="single", size=10, onChange }) {
  const [h,setH]=useState(head);
  const [s,setS]=useState(size);
  const push = ()=> onChange && onChange({ head:h, size:Number(s)||10 });
  return (
    <div className="p-2 bg-white dark:bg-[#1b1b1b] border rounded shadow">
      <div className="text-xs mb-1">Arrowhead</div>
      <div className="flex items-center gap-2 mb-2">
        <select className="text-xs px-2 py-1 bg-white dark:bg-[#111] border rounded" value={h} onChange={e=>setH(e.target.value)}>
          <option value="none">none</option>
          <option value="single">single</option>
          <option value="double">double</option>
        </select>
        <input className="w-16 text-xs px-2 py-1 bg-white dark:bg-[#111] border rounded" value={s} onChange={e=>setS(e.target.value)} />
      </div>
      <button className="text-xs px-2 py-1 border rounded" onClick={push}>Apply</button>
    </div>
  );
}
