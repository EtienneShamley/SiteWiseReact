import React from "react";

export default function Sidebar() {
  return (
    <aside className="w-64 bg-[#111] text-white p-4 border-r border-gray-700 flex flex-col space-y-2">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Projects</h2>
        <button className="bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded text-white text-xs">
          Hide
        </button>
      </div>
      <button className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm">
        + New Project
      </button>
      <button className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm">
        + New Folder
      </button>
      <button className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm">
        + New Note
      </button>
      <ul className="space-y-1 text-sm mt-4">
        {/* Placeholder projects */}
        <li className="bg-[#252525] text-white p-2 rounded flex justify-between items-center hover:bg-gray-700">
          <span>Project 1</span>
        </li>
        <li className="bg-[#252525] text-white p-2 rounded flex justify-between items-center hover:bg-gray-700">
          <span>Project 2</span>
        </li>
      </ul>
    </aside>
  );
}
