// Chromium pans a pinch-zoomed page only with scroll that chains up to the
// viewport, and `overscroll-behavior: contain` on panes like the markdown
// preview stops that chain. Flag the zoom so CSS can lift containment.
export function installPinchZoomPanning(win: Window): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const root = win.document.documentElement;
  const sync = () => {
    const zoomed = viewport.scale > 1.001;
    if (zoomed === root.hasAttribute("data-pinch-zoomed")) return;
    root.toggleAttribute("data-pinch-zoomed", zoomed);
  };
  sync();
  viewport.addEventListener("resize", sync);
  return () => viewport.removeEventListener("resize", sync);
}
