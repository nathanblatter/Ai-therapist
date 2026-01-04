import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import AdminApp from "./components/AdminApp";

export function render() {
  const html = renderToString(
    <StrictMode>
      <AdminApp />
    </StrictMode>,
  );
  return { html };
}
