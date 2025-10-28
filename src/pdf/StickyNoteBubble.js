// src/pdf/StickyNoteBubble.js
import React from "react";

export default function StickyNoteBubble({ open, note, onChangeNote, attachments, onAddFile, onAddAudio }) {
  if (!open) return null;
  return (
    <div className="absolute z-30 p-2 w-72 bg-white dark:bg-[#1b1b1b] border rounded shadow">
      <div className="text-xs mb-1">Sticky note</div>
      <textarea
        className="w-full h-20 text-sm bg-white dark:bg-[#111] border rounded p-2"
        value={note}
        onChange={(e)=>onChangeNote && onChangeNote(e.target.value)}
      />
      <div className="mt-2 flex items-center gap-2">
        <button className="text-xs px-2 py-1 border rounded" onClick={onAddAudio}>Record</button>
        <label className="text-xs px-2 py-1 border rounded cursor-pointer">
          Attach
          <input type="file" className="hidden" onChange={(e)=> onAddFile && onAddFile(e.target.files?.[0]||null)} />
        </label>
      </div>
      {!!attachments?.length && (
        <div className="mt-2 max-h-24 overflow-auto border rounded p-1">
          {attachments.map((a,idx)=>(
            <div key={idx} className="text-xs truncate">{a.name || a.type}</div>
          ))}
        </div>
      )}
    </div>
  );
}
