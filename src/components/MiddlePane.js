import React from "react";

export default function MiddlePane() {
  return (
    <aside className="w-80 bg-[#1a1a1a] text-white p-4 border-r border-gray-800 space-y-2">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Notes</h2>
        <button className="bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded text-white text-xs">
          Hide
        </button>
      </div>
      <ul className="space-y-1 text-sm">
        {/* Placeholder notes */}
        <li className="bg-[#252525] text-white p-2 rounded flex justify-between items-center hover:bg-gray-700">
          <span>Note A</span>
        </li>
        <li className="bg-[#252525] text-white p-2 rounded flex justify-between items-center hover:bg-gray-700">
          <span>Note B</span>
        </li>
      </ul>
    </aside>
  );
}
