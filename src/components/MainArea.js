import React from "react";

export default function MainArea() {
  return (
    <main className="flex-1 p-6 flex flex-col max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-white text-center mb-2">SiteWise</h1>
      <div className="flex-1 flex flex-col justify-between">
        <div className="overflow-y-auto px-2 py-2 space-y-3 border border-gray-700 rounded-lg mb-4 bg-[#2a2a2a] flex-1">
          {/* Chat history placeholder */}
          <div className="bg-green-700 text-white p-3 rounded-lg">
            Hello, this is your chat!
          </div>
        </div>
        <div className="relative mt-4">
          <textarea
            rows="3"
            placeholder="Type your note..."
            className="w-full resize-none rounded-lg p-3 pl-10 pr-20 bg-[#1a1a1a] text-white border border-gray-700 focus:outline-none focus:ring-2 focus:ring-green-400"
          ></textarea>
          <div className="absolute bottom-3 right-3 flex gap-2">
            <button
              className="text-white hover:text-red-500 text-xl"
              title="Start voice note"
            >
              🎤
            </button>
            <button
              className="bg-white text-black hover:bg-gray-300 p-2 rounded-full"
              title="Submit"
            >
              ⬆️
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
