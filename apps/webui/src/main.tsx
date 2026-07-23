import { createRoot } from "react-dom/client";
import "./app/base.css";
import "./app/desktop.css";
import "./app/mobile.css";
import "./app/resource-center.css";
import "./app/deployment.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);
