// import { createRoot } from "react-dom/client";
import { app } from "./scripts/app.js";

// Render your React component instead
// const root = createRoot(document.getElementById("app"));
// root.render(<h1>Hello, world</h1>);

export default async function main() {
  await app.setup();
  window.app = app;
  window.graph = app.graph;
  //   return <div>hhhhi</div>;
}
main();
