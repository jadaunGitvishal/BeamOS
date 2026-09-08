import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles/app.css";

// No router: the field-tech app is two or three full-screen steps, driven by
// component state, not URLs. (Stage B2 may add one if the visit workflow grows.)
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
