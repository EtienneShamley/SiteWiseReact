import React, { useContext } from "react";
import { AppStateContext } from "../context/AppStateContext";

export default function Sidebar() {
  const {
    projects,
    activeProjectId,
    activeFolderId,
    expandedProjectId,
    selectProject,
    selectFolder,
    createProject,
    createFolder,
    // TODO: Wire up more actions as you implement them in context
  } = useContext(AppStateContext);

  return (
    <aside className="w-64 bg-[#111] text-white p-4 border-r border-gray-700 flex flex-col space-y-2">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Projects</h2>
        {/* Optional: Hide/Show logic */}
      </div>
      <button onClick={createProject} className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm">
        + New Project
      </button>
      <button
        onClick={() => activeProjectId && createFolder(activeProjectId)}
        disabled={!activeProjectId}
        className={`bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm ${!activeProjectId ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        + New Folder
      </button>
      <ul className="space-y-1 text-sm mt-4">
        {projects.map((project) => (
          <li key={project.id} className="mb-1">
            {/* Project Row */}
            <div
              className={`flex justify-between items-center rounded px-2 py-1 cursor-pointer ${activeProjectId === project.id && !activeFolderId ? "bg-gray-400 text-black font-semibold" : "bg-[#111]"}`}
              onClick={() => selectProject(project.id)}
            >
              <span className="font-semibold flex items-center">
                <i className={`fas fa-chevron-${expandedProjectId === project.id ? "down" : "right"} mr-2 text-xs`}></i>
                {project.name}
              </span>
              {/* Placeholder: add rename/delete/share etc icons here as you wire up actions */}
            </div>
            {/* Folder Dropdown */}
            {expandedProjectId === project.id && (
              <ul className="ml-4 mt-2 space-y-1">
                {(project.folders || []).map((folder) => (
                  <li key={folder.id}>
                    <div
                      className={`flex justify-between items-center rounded px-2 py-1 cursor-pointer ${activeFolderId === folder.id && activeProjectId === project.id ? "bg-gray-600 font-semibold" : "bg-[#222]"}`}
                      onClick={() => selectFolder(project.id, folder.id)}
                    >
                      <span>{folder.name}</span>
                      {/* Placeholder: add rename/delete/share etc icons here as you wire up actions */}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
