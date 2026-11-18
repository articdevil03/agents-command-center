import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const states = new WeakMap();
const same = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
function inside(root, file) {
  const rel = relative(root, file);
  return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function stat(io, file) {
  try { return io.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}
// Resolve future leaves through their nearest existing ancestor, without creating anything.
function realFuture(io, file) {
  const info = stat(io, file);
  if (info) return resolve(io.realpathSync(file));
  const parent = dirname(file);
  if (parent === file) throw new Error("Owned path has no existing base.");
  return join(realFuture(io, parent), relative(parent, file));
}
function identity(info) { return info ? `${info.dev}:${info.ino}` : null; }

function checkRoot(root, state) {
  const sourceInfo = stat(state.io, root.source);
  if (sourceInfo && (sourceInfo.isSymbolicLink() ? !state.allowRootLink : !sourceInfo.isDirectory())
    || !same(realFuture(state.io, root.source), root.path)) throw new Error("Owned root changed or linked.");
  const realInfo = stat(state.io, root.path);
  if (realInfo && (realInfo.isSymbolicLink() || !realInfo.isDirectory())) throw new Error("Owned root changed or linked.");
  for (const [key, info] of [["identity", sourceInfo], ["realIdentity", realInfo]]) {
    if (state[key] !== null && identity(info) !== state[key]) throw new Error("Owned root changed.");
    if (info && state[key] === null) state[key] = identity(info);
  }
}

/** Pin an owned directory. Links above it are allowed. allowRootLink opts user data
 * into relocation; project and managed roots keep the strict default.
 * The returned opaque handle has .path (canonical) and .source (absolute original).
 * Keep the handle for the lifetime of an operation/store. io is only a test boundary.
 */
export function resolveOwnedRoot(root, { io = fs, allowRootLink = false } = {}) {
  const source = resolve(root), info = stat(io, source);
  if (info && (info.isSymbolicLink() ? !allowRootLink : !info.isDirectory())) throw new Error("Linked or invalid owned root.");
  const handle = Object.freeze({ source, path: realFuture(io, source) });
  states.set(handle, { io, allowRootLink, identity: identity(info), realIdentity: identity(stat(io, handle.path)) });
  assertOwnedPath(handle, source, { allowMissingLeaf: true });
  return handle;
}

/** Check all components at/below the pinned boundary. Returns the canonical candidate.
 * Missing components are accepted only with allowMissingLeaf:true (including future parents).
 * Both original and canonical candidate spellings are accepted. Escapes/root changes throw.
 */
export function assertOwnedPath(root, candidate, { allowMissingLeaf = false } = {}) {
  const state = states.get(root);
  if (!state) throw new Error("An owned root handle is required.");
  const { io } = state;
  checkRoot(root, state);
  const absolute = resolve(candidate);
  const file = inside(root.source, absolute) ? resolve(root.path, relative(root.source, absolute)) : absolute;
  if (!inside(root.path, file)) throw new Error("Owned path escapes its root.");
  let current = root.path;
  const parts = relative(root.path, file).split(sep).filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    const info = stat(io, current);
    if (!info) {
      if (!allowMissingLeaf) throw Object.assign(new Error("Owned path is missing."), { code: "ENOENT" });
    } else {
      if (info.isSymbolicLink()) throw new Error("Linked owned paths are refused.");
      if (i < parts.length && !info.isDirectory()) throw new Error("Invalid owned path parent.");
      const canonical = resolve(io.realpathSync(current));
      if (!inside(root.path, canonical) || !same(canonical, current)) throw new Error("Owned path escapes its root.");
    }
    if (i < parts.length) current = join(current, parts[i]);
  }
  // Recheck the original spelling after traversal, including an ancestor alias retarget.
  checkRoot(root, state);
  return file;
}
