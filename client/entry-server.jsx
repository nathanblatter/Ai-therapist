import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { Routes, Route, Navigate } from "react-router-dom";
import App from "./components/App";
import Login from "./components/Login";

export function render(url) {
  const html = renderToString(
    <StrictMode>
      <StaticRouter location={url}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<App />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </StaticRouter>
    </StrictMode>,
  );
  return { html };
}
