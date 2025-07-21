import React, { useContext } from "react";
import { AppStateContext } from "../context/AppStateContext";

export default function Sidebar() {
  const {
    state,
    activeProjectId,
    activeFolderId,
    expandedProjectId,
    setActiveSelection,
    clearActiveSelection,
    createProject,
    renameProject,
    deleteProject,
    shareProject,
    createFolder,
    renameFolder,
    deleteFolder,
    shareFolder,
    setExpandedProjectId,
  } = useContext(AppStateContext);

  return (
    <aside className="w-64 bg-[#111] text-white p-4 border-r border-gray-700 flex flex-col space-y-2">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Projects</h2>
        <button
          className="bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded text-white text-xs"
          onClick={clearActiveSelection}
        >
          Hide
        </button>
      </div>
      <button className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm" onClick={createProject}>
        + New Project
      </button>
      <button className="bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded text-white text-sm" onClick={createFolder} disabled={!activeProjectId || activeFolderId}>
        + New Folder
      </button>
      {/* Projects List */}
      <ul className="space-y-1 text-sm mt-4">
        {state.projectData.map((proj) => {
          const pid = proj.id;
          const isProjectActive = activeProjectId === pid && !activeFolderId;
          const isExpanded = expandedProjectId === pid;
          return (
            <li key={pid} className="bg-[#252525] text-white p-2 rounded flex flex-col">
              <div
                className={`flex justify-between items-center rounded cursor-pointer ${isProjectActive ? "bg-gray-400 text-black font-semibold" : ""}`}
                onClick={() => setActiveSelection(pid, null)}
              >
                <span className="font-semibold flex items-center">
                  <i className={`fas fa-chevron-${isExpanded ? "down" : "right"} mr-2 text-xs`}></i>
                  {proj.name}
                </span>
                <div className="space-x-2 text-xs flex-shrink-0">
                  <i className="fas fa-plus cursor-pointer" title="Add Folder" onClick={e => {e.stopPropagation(); createFolder(pid);}}></i>
                  <i className="fas fa-pen cursor-pointer" title="Rename" onClick={e => {e.stopPropagation(); renameProject(pid);}}></i>
                  <i className="fas fa-trash cursor-pointer" title="Delete" onClick={e => {e.stopPropagation(); deleteProject(pid);}}></i>
                  <i className="fas fa-share cursor-pointer" title="Share" onClick={e => {e.stopPropagation(); shareProject(pid);}}></i>
                </div>
              </div>
              {/* Folders */}
              {isExpanded && (
                <ul className="folder-dropdown ml-4 mt-2 space-y-1">
                  {(state.folderMap[pid] || []).map((folder) => {
                    const isFolderActive = activeFolderId === folder.id && activeProjectId === pid;
                    return (
                      <li key={folder.id} className={`text-white bg-[#222] p-2 rounded ${isFolderActive ? "bg-gray-600 font-semibold" : ""}`}>
                        <div className="flex justify-between items-center rounded cursor-pointer" onClick={() => setActiveSelection(pid, folder.id)}>
                          <span className="font-semibold">{folder.name}</span>
                          <div className="space-x-2 text-xs">
                            <i className="fas fa-pen cursor-pointer" title="Rename" onClick={e => {e.stopPropagation(); renameFolder(pid, folder.id);}}></i>
                            <i className="fas fa-trash cursor-pointer" title="Delete" onClick={e => {e.stopPropagation(); deleteFolder(pid, folder.id);}}></i>
                            <i className="fas fa-share cursor-pointer" title="Share" onClick={e => {e.stopPropagation(); shareFolder(pid, folder.id);}}></i>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
