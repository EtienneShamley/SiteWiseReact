import React from "react";
import Sidebar from "./components/Sidebar";
import MiddlePane from "./components/MiddlePane";
import MainArea from "./components/MainArea";
import ThemeToggle from "./components/ThemeToggle";
import { ThemeProvider } from "./ThemeContext";

function App() {
  return (
    <ThemeProvider>
      <div className="flex min-h-screen bg-neutral-900 relative">
        <Sidebar />
        <MiddlePane />
        <MainArea />
        <ThemeToggle />
      </div>
    </ThemeProvider>
  );
}

export default App;
