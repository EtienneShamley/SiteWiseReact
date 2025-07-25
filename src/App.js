import React from "react";
import Sidebar from "./components/Sidebar";
import MiddlePane from "./components/MiddlePane";
import MainArea from "./components/MainArea";
import ThemeToggle from "./components/ThemeToggle";
import { ThemeProvider } from "./context/ThemeContext";

function App() {
  return (
    <ThemeProvider>
      <div className="flex min-h-screen bg-white dark:bg-[#1a1a1a] text-black dark:text-white relative">
        <Sidebar />
        <MiddlePane />
        <MainArea />
      </div>
    </ThemeProvider>
  );
}
export default App;
