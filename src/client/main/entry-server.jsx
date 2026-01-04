import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { Routes, Route, Navigate } from "react-router-dom";
import App from "./components/App";
import Login from "./components/Login";
import Profile from "./components/Profile";
import ProtectedRoute from "../shared/components/ProtectedRoute";

export function render(url) {
  const html = renderToString(
    <StrictMode>
      <StaticRouter location={url}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <App />
              </ProtectedRoute>
            }
          />
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <Profile />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Login />} />
        </Routes>
      </StaticRouter>
    </StrictMode>,
  );
  return { html };
}
