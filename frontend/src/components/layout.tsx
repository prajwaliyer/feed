import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { NavBar } from "./nav-bar";
import { FeedPage } from "@/pages/feed";
import { SourcesPage } from "@/pages/sources";
import { StarredPage } from "@/pages/starred";

const pages = [
  { path: "/", element: <FeedPage /> },
  { path: "/sources", element: <SourcesPage /> },
  { path: "/starred", element: <StarredPage /> },
];

export function Layout() {
  const { pathname } = useLocation();
  const scrollPositions = useRef<Record<string, number>>({});
  const prevPath = useRef(pathname);

  // Continuously save scroll position so it's captured before navigation triggers a re-render
  useEffect(() => {
    const onScroll = () => {
      scrollPositions.current[prevPath.current] = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (prevPath.current !== pathname) {
      prevPath.current = pathname;
      requestAnimationFrame(() => {
        window.scrollTo(0, scrollPositions.current[pathname] ?? 0);
      });
    }
  }, [pathname]);

  return (
    <>
      {pages.map(({ path, element }) => (
        <main
          key={path}
          className="mx-auto min-h-screen max-w-lg pb-20"
          style={{ display: pathname === path ? "block" : "none" }}
        >
          {element}
        </main>
      ))}
      <NavBar />
    </>
  );
}
