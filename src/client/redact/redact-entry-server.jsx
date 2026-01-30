import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import RedactApp from "./components/RedactApp";

export function render() {
  const html = renderToString(
    <StrictMode>
      <RedactApp />
    </StrictMode>,
  );
  return { html };
}
