import { useEffect, useState } from "react";
// import reactLogo from "./assets/react.svg";
// import viteLogo from "/vite.svg";
import "./App.css";
import { LiteGraph, LGraphCanvas, LGraph } from "litegraph.js";

// import "./comfyui/index.html"
// import comfyweb from "./comfyui/index.html";
// import comfyIndexPublic from "/comfyIndex.html?raw";
// import imgUrl from './img.png'
import { app } from "./comfyui/scripts/app.js";

export default function App() {
  const [count, setCount] = useState(0);
  console.log("lgraph", LGraph);
  useEffect(() => {
    const setup = async () => {
      await app.setup();
      window.app = app;
      window.graph = app.graph;
    };
    setup();
  }, []);
  return (
    <div style={{ width: "1000px" }}>
      <div>
        <a href="https://vitejs.dev" target="_blank">
          {/* <img src={viteLogo} className="logo" alt="Vite logo" /> */}
        </a>
        {/* <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a> */}
      </div>
      <h1>Vite + React</h1>
      <div id="comfy-canvas"></div>
      {/* <iframe
        src="/src/comfyui/index.html"
        title="Comfy Page"
        style={{ width: "90%", height: "600px" }}
      /> */}
      {/* <iframe
        src={"/src/comfyui/index.html"}
        title="Comfy Page"
        style={{ width: "90%", height: "600px" }}
      /> */}
      {/* <ComfyIndex /> */}

      <div className="card">
        <button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <p className="read-the-docs">
        Click on the Vite and React logos to learn more
      </p>
    </div>
  );
}

import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
