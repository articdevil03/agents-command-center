(() => {
  const { check } = window.__ccHarness;
  // The page script is ordered classic scripts (public/app/*.js): a top-level `function print() {}` there would silently replace window.print.
  // A fresh iframe window holds the untouched built-ins; any of its names that the page window now answers with a function whose source is not
  // native code was overwritten. WebSocket, confirm and setTimeout are replaced on purpose by the bootstrap in test/browser-helpers.ts, so they are not findings.
  const HARNESS_REPLACED = new Set(["WebSocket", "confirm", "setTimeout"]);
  const NATIVE_SOURCE = /\{\s*\[native code\]\s*\}\s*$/;
  const overwrittenNames = (page, pristine) => Object.getOwnPropertyNames(pristine).filter((name) => {
    let value;
    try { value = page[name]; } catch { return false; }
    return typeof value === "function" && !NATIVE_SOURCE.test(Function.prototype.toString.call(value)) && !HARNESS_REPLACED.has(name);
  });
  const collisionAudit = () => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    document.body.append(frame);
    try {
      check("no top-level name in the page scripts overwrote a built-in window function", overwrittenNames(window, frame.contentWindow).length === 0, { overwritten: overwrittenNames(window, frame.contentWindow) });
      const planted = overwrittenNames({ print: function print() {} }, frame.contentWindow);
      check("control: the collision scan reports a planted print()", planted.includes("print"), { planted });
    } finally { frame.remove(); }
  };
  Object.assign(window.__ccHarness, { collisionAudit });
})();
