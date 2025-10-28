// src/pdf/CommentsPanel.js
import React from "react";

export default function CommentsPanel({ open, items, onSelect, onClose, filter, setFilter }) {
  if (!open) return null;
  const filtered = items.filter(i => !filter || i.type === filter);
  return (
    <div className="absolute right-2 top-2 bottom-2 w-72 bg-white dark:bg-[#1b1b1b] border rounded shadow flex flex-col z-20">
      <div className="p-2 flex items-center justify-between border-b">
        <div className="text-sm">Comments</div>
        <button className="text-xs px-2 py-1 border rounded" onClick={onClose}>Close</button>
      </div>
      <div className="p-2 flex items-center gap-2 border-b">
        <select className="text-xs px-2 py-1 bg-white dark:bg-[#111] border rounded w-full" value={filter || ""} onChange={e=>setFilter(e.target.value || null)}>
          <option value="">All</option>
          <option value="typewriter">Typewriter</option>
          <option value="textbox">Textbox</option>
          <option value="callout">Callout</option>
          <option value="sticky">Sticky</option>
          <option value="arrow">Arrow</option>
          <option value="highlight">Highlight</option>
          <option value="underline">Underline</option>
          <option value="strike">Strikeout</option>
        </select>
      </div>
      <div className="flex-1 overflow-auto p-2">
        {filtered.map(i=>(
          <button key={i.id} className="w-full text-left text-xs px-2 py-1 border rounded mb-1"
            onClick={()=>onSelect && onSelect(i.id)}>
            <div>{i.type} — {i.page}</div>
            {i.text ? <div className="opacity-70 truncate">{i.text}</div> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
