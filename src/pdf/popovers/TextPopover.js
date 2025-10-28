// src/pdf/popovers/TextPopover.js
import React, { useState } from "react";

export default function TextPopover({ color="#111111", size=14, align="left", family, onChange }) {
  const [c,setC]=useState(color);
  const [s,setS]=useState(size);
  const [a,setA]=useState(align);
  const [f,setF]=useState(family || "system-ui, -apple-system, Segoe UI, Roboto, sans-serif");
  const push = ()=> onChange && onChange({ color:c, size:Number(s)||14, align:a, family:f });

  return (
    <div className="p-2 bg-white dark:bg-[#1b1b1b] border rounded shadow">
      <div className="text-xs mb-1">Text</div>
      <div className="flex flex-col gap-2">
        <input className="w-48 text-xs px-2 py-1 bg-white dark:bg-[#111] border rounded" value={c} onChange={e=>setC(e.target.value)} />
        <div className="flex gap-2">
          <input className="w-16 text-xs px-2 py-1 bg-white dark:bg-[#111] border rounded" value={s} onChange={e=>setS(e.target.value)} />
          <select className="text-xs px-2 py-1 bg-white dark:bg-[#111] border rounded" value={a} onChange={e=>setA(e.target.value)}>
            <option value="left">left</option><option value="center">center</option><option value="right">right</option>
          </select>
        </div>
        <input className="w-64 text-xs px-2 py-1 bg-white dark:bg-[#111] border rounded" value={f} onChange={e=>setF(e.target.value)} />
        <button className="text-xs px-2 py-1 border rounded" onClick={push}>Apply</button>
      </div>
    </div>
  );
}
