// src/pdf/popovers/FillPopover.js
import React from "react";

export default function FillPopover({ value = "rgba(255,255,0,0.25)", onChange }) {
  return (
    <div className="p-2 bg-white dark:bg-[#1b1b1b] border rounded shadow">
      <div className="mb-1 text-xs">Fill</div>
      <input
        type="text"
        className="w-44 text-xs px-2 py-1 bg-white dark:bg-[#111] border rounded"
        value={value}
        onChange={(e) => onChange && onChange(e.target.value)}
        placeholder="rgba(255,255,0,0.25) or #RRGGBB"
      />
      <div className="mt-2 flex gap-1">
        {["#FFF59D","#FFECB3","#C8E6C9","#BBDEFB","#FFCDD2","transparent"].map(c => (
          <button key={c} className="text-xs px-2 py-1 border rounded" onClick={() => onChange && onChange(c)}>{c}</button>
        ))}
      </div>
    </div>
  );
}
