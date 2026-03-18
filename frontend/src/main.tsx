import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/layout";
import { FeedPage } from "./pages/feed";
import { SourcesPage } from "./pages/sources";
import { StarredPage } from "./pages/starred";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<FeedPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/starred" element={<StarredPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>
);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}
