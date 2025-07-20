import React from "react";

export default function MainArea() {
  return (
    <main className="flex-1 p-6 flex flex-col max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-white text-center mb-2">SiteWise</h1>
      <div className="flex-1 flex flex-col justify-between">
        <div className="overflow-y-auto px-2 py-2 space-y-3 border border-gray-700 rounded-lg mb-4 bg-[#2a2a2a] flex-1">
          {/* Chat window/messages here */}
          <div className="text-gray-300">Chat or editor UI here…</div>
        </div>
        <div>
          {/* Input, buttons, etc. */}
          <textarea
            className="w-full resize-none rounded-lg p-3 pl-10 pr-20 bg-[#1a1a1a] text-white border border-gray-700 mb-2"
            placeholder="Type your note..."
            rows={3}
          />
          <div className="flex gap-2 justify-end">
            <button className="bg-gray-800 px-3 py-1 rounded text-white">Send</button>
          </div>
        </div>
      </div>
    </main>
  );
}
