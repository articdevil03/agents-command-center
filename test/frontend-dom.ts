// Minimal tree operations used by renderChat. Markup stays literal so existing exact HTML assertions still exercise the real renderer.
export function chatNode(id = "") {
  const children: any[] = [];
  const node: any = { id, children, parentNode: null, dataset: {}, raw: "",
    get innerHTML() { return this.raw + children.map((child) => child.innerHTML).join(""); },
    set innerHTML(value) { this.raw = value; for (const child of children) child.parentNode = null; children.length = 0; },
    append(...items: any[]) {
      for (const item of items) {
        if (item.fragment) { this.append(...[...item.children]); continue; }
        item.remove(); item.parentNode = this; children.push(item);
      }
    },
    prepend(item: any) { item.remove(); item.parentNode = this; children.unshift(item); },
    remove() { if (this.parentNode) { const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; } },
    contains(item: any): boolean { return item === this || children.some((child) => child.contains(item)); },
  };
  return node;
}
export function chatTemplate() {
  const content = chatNode(); content.fragment = true;
  return { content, set innerHTML(value: string) { const child = chatNode(); child.innerHTML = value; content.innerHTML = ""; content.append(child); } };
}
