import { stripVTControlCharacters } from "node:util";
import { isSafeShape } from "../../config-files.ts";
import type { RunCli } from "../types.ts";

export type OpenCodeModelInfo = { value: string; providerID: string; modelID: string; displayName: string; variants: string[] | null };
export const validOpenCodeId = (value: unknown): value is string => isSafeShape(value)
  && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/:-]+$/.test(value);

// Pretty-printed JSON has nested objects and braces inside strings. Walk the
// complete object before parsing it; never publish a successfully parsed prefix.
export function parseOpenCodeModelInfo(output: string): OpenCodeModelInfo[] | null {
  const text = stripVTControlCharacters(output).replace(/^\uFEFF/, "");
  const found = new Map<string, OpenCodeModelInfo>();
  const bodies = new Map<string, string>();
  let at = 0;
  try {
    while (at < text.length) {
      while (/\s/.test(text[at] ?? "") && at < text.length) at++;
      if (at === text.length) break;
      const end = text.indexOf("\n", at);
      if (end < 0) return null;
      const value = text.slice(at, end).trim();
      if (!validOpenCodeId(value)) return null;
      at = end + 1;
      while (/\s/.test(text[at] ?? "") && at < text.length) at++;
      if (text[at] !== "{") return null;
      const start = at;
      let depth = 0, quoted = false, escaped = false;
      do {
        const char = text[at++];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}") depth--;
      } while (at < text.length && depth > 0);
      if (depth !== 0 || quoted) return null;
      if (at < text.length && !/[\r\n]/.test(text[at])) return null;
      const body = JSON.parse(text.slice(start, at));
      if (typeof body.providerID !== "string" || typeof body.id !== "string"
        || `${body.providerID}/${body.id}` !== value) return null;
      if (!body.variants || typeof body.variants !== "object" || Array.isArray(body.variants)) return null;
      const variants = Object.keys(body.variants);
      if (variants.some((variant) => !isSafeShape(variant) || !/^[A-Za-z0-9._-]+$/.test(variant)
        || !body.variants[variant] || typeof body.variants[variant] !== "object" || Array.isArray(body.variants[variant]))) return null;
      const info: OpenCodeModelInfo = { value, providerID: body.providerID, modelID: body.id,
        displayName: typeof body.name === "string" && body.name.trim() ? body.name : body.id, variants };
      const serialized = JSON.stringify(body), previous = bodies.get(value);
      if (previous && previous !== serialized) return null;
      bodies.set(value, serialized);
      found.set(value, info);
    }
    return found.size ? [...found.values()] : null;
  } catch { return null; }
}

export function openCodeEfforts(models: readonly OpenCodeModelInfo[], model: string): string[] {
  return ["", ...(models.find((item) => item.value === model)?.variants ?? [])];
}

export type ModelRefreshState = { fallback: boolean; refreshing?: boolean; stale?: boolean; error?: string | null };
export class OpenCodeModelRefresh {
  private generation = 0;
  private current: Promise<void> | null = null;
  private pending = new Set<Promise<void>>();
  private closed = false;
  private hasCatalogue = false;
  private run: RunCli;
  private publish: (models: OpenCodeModelInfo[] | null, state: Partial<ModelRefreshState>) => void;
  constructor(run: RunCli, publish: (models: OpenCodeModelInfo[] | null, state: Partial<ModelRefreshState>) => void) {
    this.run = run; this.publish = publish;
  }
  get busy(): boolean { return this.pending.size > 0; }
  refresh(fresh = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.current && !fresh) return this.current;
    const generation = ++this.generation;
    const work = Promise.resolve().then(async () => {
      let models: OpenCodeModelInfo[] | null = null;
      try {
        const result = await this.run("opencode", ["models", "--verbose"], { timeoutMs: 10_000, env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } });
        if (result.code === 0) models = parseOpenCodeModelInfo(result.stdout);
      } catch { /* A discovery failure never changes a successful install or key save. */ }
      if (generation !== this.generation) return;
      if (models) this.hasCatalogue = true;
      this.publish(models, { refreshing: false, stale: !models && this.hasCatalogue, error: models ? null : "Could not refresh models. Try again." });
    });
    this.current = work;
    this.pending.add(work);
    this.publish(null, { refreshing: true });
    void work.finally(() => { this.pending.delete(work); if (this.current === work) this.current = null; this.publish(null, {}); }).catch(() => {});
    return work;
  }
  close(): void { this.closed = true; }
  async drain(): Promise<void> { this.close(); await Promise.all([...this.pending]); }
}
