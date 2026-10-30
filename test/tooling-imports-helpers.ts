import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

// >>> THE EXE SHIPPED BROKEN ON 2026-09-09 AND 616 GREEN TESTS SAW NOTHING. <<<
// `server/leader-tools.ts` imports zod, which was never in `dependencies` --
// it is a PEER dependency of the agent SDK, so npm installs it at the repo
// root and every test, every `npm start`, every dev run resolved it happily.
// electron-builder walks declared production dependencies and does not follow
// peers, so the packaged app shipped without it and died on launch with
// ERR_MODULE_NOT_FOUND before the server was ready.
//
// Cheap common-static-shape check, not a JavaScript parser or packaging proof.
// Round 1 found three defects; round 2 found five, all from hand-rolling a lexer.
// Unsupported constructs throw instead of guessing. scripts/packaged-smoke.mjs
// is the real proof that the packaged server resolves its startup imports --
// but it starts server/index.ts under plain node, same as production does. It
// never loads electron/main.js, so this static scan is the ONLY check on
// electron/'s imports; that directory has nothing beyond runtime-provided
// electron today, but the smoke's readiness proof does not extend to it.
export type Token = { type: "word" | "punct" | "string" | "dynamic-template"; value?: string; escaped?: boolean; offset?: number; line: number };

// Keywords after which a following `/` starts a regex, not a division --
// needed so a regex literal (which can legally contain "//" or quotes) is
// consumed as one opaque unit instead of being misread as a comment or a
// stray string delimiter.
export const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "yield", "case", "do", "else", "extends", "default", "await",
]);

// Keep this deliberately limited. Do not grow a JavaScript parser here.
export function tokenize(source: string, label: string): Token[] {
  const fail = (line: number, construct: string): never => {
    throw new Error(`${label}:${line}: ${construct}; this construct cannot be checked statically; verify by hand that its package is declared`);
  };
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  // Last real code emitted: a "value" (identifier, number, `)`, `]`, a
  // literal) means a following `/` is division; anything else means `/` can
  // start a regex.
  let prevIsValue = false;

  while (i < source.length) {
    const c = source[i];

    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }

    if (c === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line++;
        i++;
      }
      if (i >= source.length) fail(line, "unterminated block comment");
      i += 2;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      const startLine = line;
      i++;
      let value = "";
      let escaped = false;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") { escaped = true; if (source[i + 1] === "\n") line++; value += source[i + 1] ?? ""; i += 2; continue; }
        if (source[i] === "\n") line++;
        value += source[i]; i++;
      }
      if (i >= source.length) fail(startLine, "unterminated string");
      i++;
      tokens.push({ type: "string", value, escaped, line: startLine });
      prevIsValue = true;
      continue;
    }

    if (c === "`") {
      const startLine = line;
      i++;
      let value = "";
      let escaped = false;
      let dynamic = false;
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") { escaped = true; if (source[i + 1] === "\n") line++; value += source[i + 1] ?? ""; i += 2; continue; }
        if (source[i] === "$" && source[i + 1] === "{") {
          dynamic = true;
          // Fail conservatively before skipping executable template text.
          if (/\b(?:import|require)\b/.test(source.slice(i + 2, source.indexOf("`", i + 2) < 0 ? source.length : source.indexOf("`", i + 2)))) fail(line, "template interpolation containing import/require");
          const expressionStart = i;
          i += 2;
          let depth = 1;
          while (i < source.length && depth > 0) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") depth--;
            if (source[i] === "\n") line++;
            i++;
          }
          if (/\b(?:import|require)\b/.test(source.slice(expressionStart, i))) fail(startLine, "template interpolation containing import/require");
          if (depth) fail(startLine, "unterminated template interpolation");
          continue;
        }
        if (source[i] === "\n") line++;
        value += source[i]; i++;
      }
      if (i >= source.length) fail(startLine, "unterminated template");
      i++;
      tokens.push(dynamic ? { type: "dynamic-template", line: startLine } : { type: "string", value, escaped, line: startLine });
      prevIsValue = true;
      continue;
    }

    if (c === "\\") fail(line, "escaped identifier");
    // Division and a regex literal are indistinguishable here without real
    // parsing -- unlike every other fail() below, nothing about this
    // construct implies an import is present, so it gets its own message
    // instead of the generic "verify by hand that its package is declared"
    // (that phrasing is honest for e.g. an unterminated string, where
    // anything, including an import, could be hiding past the cutoff -- it's
    // false for `(a + b) / 2`, which is plain arithmetic with nothing to
    // declare).
    if (c === "/" && ["}", ")", "]"].includes(tokens.at(-1)?.value ?? "")) {
      throw new Error(`${label}:${line}: regex-vs-division ambiguity; this line cannot be tokenized statically (a division and a regex literal look identical here) -- nothing on this line implies an import, but the scan has stopped, so check the rest of this file by hand if you need to be sure`);
    }
    if (c === "/" && !prevIsValue) {
      const regexLine = line;
      const regexStart = i;
      let closed = false;
      i++;
      let inClass = false;
      while (i < source.length) {
        const rc = source[i];
        if (rc === "\\") { i += 2; continue; }
        if (rc === "[") { inClass = true; i++; continue; }
        if (rc === "]") { inClass = false; i++; continue; }
        if (rc === "/" && !inClass) { i++; closed = true; break; }
        if (rc === "\n") break;
        i++;
      }
      if (/\b(?:import|require)\b/.test(source.slice(regexStart, i))) fail(regexLine, "regex-vs-division ambiguity containing import/require");
      if (!closed) fail(regexLine, "unterminated regex or regex-vs-division ambiguity");
      while (i < source.length && /[a-zA-Z]/.test(source[i])) i++;
      prevIsValue = true;
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
      const value = source.slice(start, i);
      tokens.push({ type: "word", value, line, offset: start });
      prevIsValue = !REGEX_PRECEDING_KEYWORDS.has(value);
      continue;
    }

    if (/[0-9]/.test(c)) {
      while (i < source.length && /[0-9.]/.test(source[i])) i++;
      prevIsValue = true;
      continue;
    }

    tokens.push({ type: "punct", value: c, line });
    prevIsValue = c === ")" || c === "]";
    i++;
  }

  return tokens;
}

export function bareImportsOf(source: string, label = "source"): string[] {
  const tokens = tokenize(source, label);
  const fail = (t: Token, construct: string): never => {
    throw new Error(`${label}:${t.line}: ${construct}; this construct cannot be checked statically; verify by hand that its package is declared`);
  };
  // Backstop independent of interpolation brace counting: a raw load call in
  // a file with interpolation must have survived as a code token. This may
  // flag prose; it deliberately does not try to parse nested template syntax.
  if (source.includes("${")) {
    for (const match of source.matchAll(/\b(?:import|require)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\(/g)) {
      if (!tokens.some(t => t.type === "word" && t.offset === match.index)) {
        fail({ type: "word", line: source.slice(0, match.index).split("\n").length }, "template interpolation or opaque text containing import/require");
      }
    }
  }
  const literal = (t: Token) => {
    if (t.escaped) fail(t, "escape sequence in specifier");
    return t.value ?? "";
  };
  const found: string[] = [];

  const collect = (spec: string) => {
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return;
    // "@scope/pkg/sub" and "pkg/sub" both resolve to their package root.
    const parts = spec.split("/");
    found.push(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
  };

  // Forward scan without a token cap for `from "spec"` (import/export re-exports). Bails
  // at a `;` or the next import/export so a plain declaration with no
  // re-export never picks up an unrelated later "from".
  const findFrom = (start: number): number => {
    for (let j = start; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.type === "punct" && t.value === ";") return -1;
      if (t.type === "word" && (t.value === "import" || t.value === "export")) return -1;
      if (t.type === "word" && t.value === "from" && tokens[j + 1]?.type === "string") return j + 1;
    }
    return -1;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "word") continue;

    if (t.value === "import") {
      const next = tokens[i + 1];
      if (next?.type === "punct" && next.value === "(") {
        const arg = tokens[i + 2];
        if (arg?.type === "string" && tokens[i + 3]?.value === ")") { collect(literal(arg)); continue; }
        // A genuinely dynamic specifier (a variable, a template with
        // interpolation) can't be resolved by a static scanner -- silently
        // accepting it would mean silently NOT checking it, exactly the gap
        // this guard exists to close. Fail loudly instead.
        fail(t, "dynamic import() has a non-literal or composed specifier");
      }
      if (next?.type === "string") { collect(literal(next)); continue; } // side-effect import
      if (next?.value === ".") continue; // import.meta
      const fromIdx = findFrom(i + 1);
      if (fromIdx < 0) fail(t, "unrecognized static import");
      collect(literal(tokens[fromIdx]));
      continue;
    }

    if (t.value === "export") {
      const fromIdx = findFrom(i + 1);
      if (fromIdx >= 0) collect(literal(tokens[fromIdx]));
      continue;
    }

    if (t.value === "require") {
      const open = tokens[i + 1];
      const arg = tokens[i + 2];
      if (open?.type === "punct" && open.value === "(") {
        if (arg?.type !== "string" || tokens[i + 3]?.value !== ")") fail(t, "require() has a non-literal or composed specifier");
        collect(literal(arg));
      } else fail(t, "indirect require reference");
      continue;
    }
  }

  return found;
}

export function sourceFilesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...sourceFilesUnder(join(dir, entry.name), exts));
      continue;
    }
    if (exts.some((e) => entry.name.endsWith(e))) out.push(join(dir, entry.name));
  }
  return out;
}

export type ShippedFile = { file: string; source: string; runtimeProvided: Set<string> };

// Electron itself is the host process, not something the app bundles -- it is
// a devDependency on purpose and is always present at runtime, but only
// inside electron/, which is the process that actually has it. server/ runs
// under plain `node` (startServer in electron/server-process.js starts it) and has no Electron
// APIs, so the same exemption there would hide a real missing dependency.
export const RUNTIME_PROVIDED = new Set(["electron"]);

export function undeclaredImports(files: ShippedFile[], declared: Set<string>): string[] {
  const undeclared: string[] = [];
  for (const { file, source, runtimeProvided } of files) {
    for (const pkg of bareImportsOf(source, file)) {
      if (runtimeProvided.has(pkg) || declared.has(pkg)) continue;
      undeclared.push(`${file} imports "${pkg}"`);
    }
  }
  return undeclared;
}

// package.json's build.files ships every extension under server/ and
// electron/, not just the ones this repo happens to use today, so the scan
// covers the same set. public/ is deliberately excluded: the renderer runs
// with Node integration disabled and loads plain browser scripts, not runtime
// imports -- there is nothing for either to resolve.
export function realShippedFiles(serverProbe?: string): ShippedFile[] {
  const load = (dir: string, runtimeProvided: Set<string>, probe?: string): ShippedFile[] => {
    const files = sourceFilesUnder(dir, [".ts", ".js", ".mjs", ".cjs"])
      .map((file) => ({ file, source: readFileSync(join(root, file), "utf8"), runtimeProvided }));
    if (probe !== undefined) files.push({ file: join(dir, "__packaging_probe__.ts"), source: probe, runtimeProvided });
    return files;
  };
  return [...load("server", new Set(), serverProbe), ...load("electron", RUNTIME_PROVIDED)];
}
