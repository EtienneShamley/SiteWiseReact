import React from "react";
import Sidebar from "./components/Sidebar";
import MiddlePane from "./components/MiddlePane";
import MainArea from "./components/MainArea";
import ThemeToggle from "./components/ThemeToggle";

function App() {
  return (
    <div className="flex min-h-screen bg-gray-950 relative">
      <Sidebar />
      <MiddlePane />
      <MainArea />
      <ThemeToggle />
    </div>
  );
}

export default App;
