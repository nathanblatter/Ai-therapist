import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import AdminApp from "./components/AdminApp";
import "../shared/base.css";

// Add hydrated class to prevent FOUC
document.body.classList.add('hydrated');

ReactDOM.hydrateRoot(
  document.getElementById("root"),
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
