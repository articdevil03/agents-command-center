// The in-page audit script, evaluated in the headless Chrome page by chromeAudit.
// The in-page audit. window.__ov(label, rootSelector) -> { texts, controls, violations }.
export const AUDIT_JS = String.raw`
(() => {
  const cs = (node) => getComputedStyle(node);
  const visible = (node) => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const hasTransform = (style) => style.transform !== "none" || style.willChange.includes("transform");
  const clipsOf = (element, includeSelf) => {
    const out = []; let current = element;
    const own = includeSelf ? cs(element) : null;
    if (own && (own.overflowX !== "visible" || own.overflowY !== "visible")) out.push({ node: element, x: own.overflowX !== "visible", y: own.overflowY !== "visible", scrollX: /auto|scroll/.test(own.overflowX), scrollY: /auto|scroll/.test(own.overflowY), style: own });
    while (current && current !== document.body && current.parentElement) {
      const position = cs(current).position;
      if (position === "fixed") break;
      let parent = current.parentElement;
      if (position === "absolute") while (parent && parent !== document.body && cs(parent).position === "static" && !hasTransform(cs(parent))) parent = parent.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      const style = cs(parent);
      const x = style.overflowX !== "visible", y = style.overflowY !== "visible";
      if (x || y) out.push({ node: parent, x, y, scrollX: /auto|scroll/.test(style.overflowX), scrollY: /auto|scroll/.test(style.overflowY), style });
      current = parent;
    }
    return out;
  };
  const clipBox = (node) => { const box = node.getBoundingClientRect(); return { left: box.left + node.clientLeft, top: box.top + node.clientTop, right: box.left + node.clientLeft + node.clientWidth, bottom: box.top + node.clientTop + node.clientHeight }; };
  const intersect = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const empty = (r) => r.right - r.left <= 0.5 || r.bottom - r.top <= 0.5;
  const plain = (r) => ({ left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10, right: Math.round(r.right * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 });
  const describe = (element, extra = "") => {
    const classes = String(element.className?.baseVal ?? element.className ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    const label = (element.textContent || element.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 34);
    return element.tagName.toLowerCase() + (element.id ? "#" + element.id : "") + (classes ? "." + classes : "") + ' "' + (extra || label) + '"';
  };
  const visibleRect = (raw, element, includeSelf) => {
    let rect = { left: raw.left, top: raw.top, right: raw.right, bottom: raw.bottom };
    rect = intersect(rect, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    for (const clip of clipsOf(element, includeSelf)) {
      const box = clipBox(clip.node);
      rect = intersect(rect, { left: clip.x ? box.left : -1e9, top: clip.y ? box.top : -1e9, right: clip.x ? box.right : 1e9, bottom: clip.y ? box.bottom : 1e9 });
    }
    return rect;
  };
  const color = (value) => { const m = /rgba?\(([^)]+)\)/.exec(value); if (!m) return 0; const parts = m[1].split(/[ ,\/]+/).filter(Boolean); return parts.length > 3 ? Number(parts[3]) : 1; };
  window.__ov = (label, rootSelector) => {
    const root = rootSelector ? document.querySelector(rootSelector) : document.body;
    const result = { label, found: Boolean(root), root: rootSelector ?? "body", texts: 0, controls: 0, violations: [] };
    if (!root) return result;
    const items = []; const violations = result.violations;
    const add = (type, a, b, detail) => violations.push({ type, a, b, detail });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue.trim() || parent.closest("script,style,noscript,option,textarea,svg,select")) continue;
      if (!visible(parent)) continue;
      range.selectNodeContents(node);
      for (const raw of range.getClientRects()) {
        if (raw.width < 1 || raw.height < 1) continue;
        const vis = visibleRect(raw, parent, true);
        if (empty(vis)) continue;
        result.texts++;
        const trim = raw.height * 0.2;
        items.push({ kind: "text", el: parent, node, raw, vis, box: { left: vis.left, right: vis.right, top: vis.top + trim, bottom: vis.bottom - trim }, name: describe(parent, node.nodeValue.trim().slice(0, 34)) });
      }
    }
    const selector = 'button,a[href],input:not([type=hidden]),select,textarea,[role=tab],[role=radio],[role=button],summary';
    for (const element of [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)]) {
      if (!visible(element)) continue;
      const raw = element.getBoundingClientRect();
      if (raw.width < 1 || raw.height < 1) continue;
      const vis = visibleRect(raw, element);
      if (empty(vis)) continue;
      result.controls++;
      items.push({ kind: "ctl", el: element, raw, vis, box: vis, name: describe(element) });
    }
    const allowed = (a, b) => window.__ovAllowed.some((rule) => (a.el.closest(rule.a) && b.el.closest(rule.b)) || (a.el.closest(rule.b) && b.el.closest(rule.a)));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.node && a.node === b.node) continue;
      if ((a.kind === "ctl" || b.kind === "ctl") && (a.el.contains(b.el) || b.el.contains(a.el))) continue;
      // A tab's own options button is laid over the right padding the tab reserves for it (it is the tab's next sibling, never inside a role=tab); the tab's text is still checked against it.
      if (a.kind === "ctl" && b.kind === "ctl" && [[a.el, b.el], [b.el, a.el]].some(([tab, more]) => tab.getAttribute("role") === "tab" && tab.nextElementSibling === more && more.classList.contains("dots"))) continue;
      const x = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const y = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (x > 1 && y > 1 && !allowed(a, b)) add("overlap", a.name, b.name, "by " + x.toFixed(1) + "x" + y.toFixed(1) + " px at " + JSON.stringify(plain(a.box)));
    }
    const seen = new Set();
    for (const item of items) {
      if (item.kind !== "text") continue;
      let stopX = false, stopY = false;
      for (const clip of clipsOf(item.el, true)) {
        const box = clipBox(clip.node); const height = item.raw.bottom - item.raw.top;
        if (clip.x && !stopX) {
          if (clip.scrollX) stopX = true;
          else {
            const cut = Math.max(item.raw.right - box.right, box.left - item.raw.left);
            if (cut > 1) {
              const key = "x" + item.name + cut.toFixed(0);
              if (clip.style.textOverflow === "ellipsis") { if (!item.el.closest("[title]") && !seen.has("t" + key)) { seen.add("t" + key); add("ellipsis-no-title", item.name, describe(clip.node), "text cut with an ellipsis but no title tooltip"); } }
              else if (!seen.has(key)) { seen.add(key); add("clipped-x", item.name, describe(clip.node), "cut off by " + cut.toFixed(1) + " px with no ellipsis"); }
              stopX = true;
            }
          }
        }
        if (clip.y && !stopY) {
          if (clip.scrollY) stopY = true;
          else {
            const cut = Math.max(item.raw.bottom - box.bottom, box.top - item.raw.top);
            if (cut > height * 0.3 && !/^[1-9]/.test(clip.style.webkitLineClamp || "none")) {
              const key = "y" + item.name + cut.toFixed(0);
              if (!seen.has(key)) { seen.add(key); add("clipped-y", item.name, describe(clip.node), "cut off by " + cut.toFixed(1) + " px vertically"); }
              stopY = true;
            }
          }
        }
      }
      if (!stopX && (item.raw.right > innerWidth + 1 || item.raw.left < -1)) add("past-window", item.name, "window", "text reaches " + item.raw.right.toFixed(0) + " of " + innerWidth);
      if (!stopX) {
        let ancestor = item.el;
        while (ancestor && ancestor !== root.parentElement && ancestor !== document.body) {
          const style = cs(ancestor);
          if (style.overflowX !== "visible") break;
          const border = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
          if ((border > 0 || color(style.backgroundColor) > 0.05) && style.display !== "inline" && style.position !== "fixed") {
            const box = ancestor.getBoundingClientRect();
            const over = Math.max(item.raw.right - box.right, box.left - item.raw.left);
            if (over > 1) { const key = "s" + item.name + describe(ancestor); if (!seen.has(key)) { seen.add(key); add("spills-out", item.name, describe(ancestor), "runs " + over.toFixed(1) + " px outside its box"); } break; }
          }
          ancestor = ancestor.parentElement;
        }
      }
    }
    return result;
  };
  window.__ovAllowed = [];
})()
`;
