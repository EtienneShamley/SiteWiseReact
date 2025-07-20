import React from 'react';

function App() {
  return (
    <div className="flex min-h-screen bg-[#1a1a1a] text-white">
      {/* Sidebar */}
      <aside className="w-60 bg-[#111] p-4 border-r border-gray-700 flex flex-col space-y-2">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold">Projects</h2>
          <button className="bg-gray-800 px-2 py-1 rounded text-xs">Hide</button>
        </div>
        <button className="bg-gray-800 px-3 py-1 rounded text-sm">+ New Project</button>
        <button className="bg-gray-800 px-3 py-1 rounded text-sm">+ New Folder</button>
        <button className="bg-gray-800 px-3 py-1 rounded text-sm">+ New Note</button>
        {/* List of projects/folders here */}
      </aside>
      {/* Middle Pane */}
      <aside className="w-72 bg-[#1a1a1a] p-3 border-r border-gray-800">
        <h2 className="text-lg font-semibold mb-2">Notes</h2>
        {/* Notes list here */}
      </aside>
      {/* Main Area */}
      <main className="flex-1 p-6 flex flex-col max-w-4xl mx-auto">
        <div className="w-full flex justify-end mb-2">
          <button
            className="bg-gray-800 text-white px-3 py-1 rounded hover:bg-gray-600 text-lg shadow"
            title="Toggle dark/light mode"
          >🌙</button>
        </div>
        <h1 className="text-2xl font-bold text-white text-center mb-2">SiteWise</h1>
        <div className="flex-1 flex flex-col justify-between">
          <div className="overflow-y-auto px-2 py-2 space-y-3 border border-gray-700 rounded-lg mb-4 bg-[#2a2a2a] flex-1">
            {/* Chat window/messages here */}
          </div>
          {/* Input, buttons, etc. */}
        </div>
      </main>
    </div>
  );
}

export default App;
