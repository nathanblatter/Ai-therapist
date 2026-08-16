import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import AdminApp from "./components/AdminApp";
import "../shared/base.css";

// Add hydrated class to prevent FOUC
document.body.classList.add('hydrated');

// Admin is a plain SPA (no SSR) — render into the empty root.
ReactDOM.createRoot(document.getElementById("root") as Element).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
