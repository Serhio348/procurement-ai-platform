/** Auth and console use separate routers. Leave /login before the console mounts. */
export function openConsolePath(): void {
  if (window.location.pathname === "/" || window.location.pathname.startsWith("/procurements") || window.location.pathname.startsWith("/profiles") || window.location.pathname === "/admin") {
    return;
  }
  window.history.replaceState(null, "", "/");
}
