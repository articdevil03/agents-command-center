export const DEFAULT_WINDOW_BOUNDS = { width: 1400, height: 900 };
export const MIN_WIDTH = 900;
export const MIN_HEIGHT = 600;

// `displays` is injected (Electron's screen.getAllDisplays().map(d => d.workArea))
// so this stays a plain function callers can unit-test with fake geometry.
export function sanitizeWindowBounds(bounds, displays) {
  if (!bounds || typeof bounds !== "object") return { ...DEFAULT_WINDOW_BOUNDS };
  const { width, height, x, y } = bounds;
  if (typeof width !== "number" || typeof height !== "number") return { ...DEFAULT_WINDOW_BOUNDS };
  if (width < MIN_WIDTH || height < MIN_HEIGHT || width > 10000 || height > 10000) return { ...DEFAULT_WINDOW_BOUNDS };
  if (typeof x !== "number" || typeof y !== "number") return { width, height };
  // Leave a draggable strip, excluding the system menu and caption buttons.
  const onScreen = displays.some((d) => Math.min(x + width - 160, d.x + d.width) - Math.max(x + 40, d.x) >= 100 && y >= d.y && y + 32 <= d.y + d.height);
  return onScreen ? { width, height, x, y } : { ...DEFAULT_WINDOW_BOUNDS };
}

// A window that was maximized when it closed comes back maximized: `maximized` is only present (true) when it was.
export function readWindowBounds(readFileFn, path, displays) {
  try {
    const saved = JSON.parse(readFileFn(path, "utf8"));
    return { ...sanitizeWindowBounds(saved, displays), ...(saved?.maximized === true ? { maximized: true } : {}) };
  } catch {
    return { ...DEFAULT_WINDOW_BOUNDS };
  }
}

export function writeWindowBounds(writeFileFn, path, bounds) {
  try {
    writeFileFn(path, JSON.stringify({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, ...(bounds.maximized === true ? { maximized: true } : {}) }));
  } catch {
    // best-effort: losing the saved window position is not worth crashing over
  }
}
