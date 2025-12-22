import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import AdminApp from "./components/AdminApp";
import "../base.css";

ReactDOM.hydrateRoot(
  document.getElementById("root"),
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
