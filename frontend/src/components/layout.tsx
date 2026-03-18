import { Outlet } from "react-router-dom";
import { NavBar } from "./nav-bar";

export function Layout() {
  return (
    <>
      <main className="mx-auto max-w-lg pb-20">
        <Outlet />
      </main>
      <NavBar />
    </>
  );
}
