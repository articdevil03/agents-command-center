import * as fs from "node:fs";
import { resolve, join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

const LIMIT = 16 * 1024;
const toolValid = (tool) => typeof tool === "string" && tool.length <= 32 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool);
function recordJson(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid credential record.");
  const fields = Object.entries(record);
  if (!fields.length || fields.some(([key, value]) => !/^[a-z][a-zA-Z0-9]*$/.test(key) || typeof value !== "string")) throw new Error("Invalid credential record.");
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json) > LIMIT) throw new Error("Invalid credential size.");
  return json;
}

// Synchronous filesystem operations keep each replacement indivisible within this process.
// io is an injectable filesystem boundary; production always uses node:fs.
export function createCliCredentialStore({ safeStorage, dir, io = fs }) {
  const directory = resolve(dir);
  const available = () => { try { return safeStorage.isEncryptionAvailable() === true; } catch { return false; } };
  function checkDirectory(create = false) {
    if (!io.existsSync(directory)) {
      if (!create) return false;
      const parent = dirname(directory);
      if (io.realpathSync(parent).toLowerCase() !== parent.toLowerCase()) throw new Error("Unsafe credential directory.");
      io.mkdirSync(directory, { mode: 0o700 });
    }
    const stat = io.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || io.realpathSync(directory).toLowerCase() !== directory.toLowerCase()) throw new Error("Unsafe credential directory.");
    return true;
  }
  function fileFor(tool) {
    if (!toolValid(tool)) throw new Error("Invalid credential tool.");
    return join(directory, tool + ".cred");
  }
  function checkFile(file) {
    try { const stat = io.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe credential file."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return {
    available,
    async set(tool, record) {
      let temp = null, descriptor = null;
      try {
        const file = fileFor(tool), json = recordJson(record);
        if (!available()) throw new Error("Credential encryption unavailable.");
        const encrypted = safeStorage.encryptString(json);
        if (!Buffer.isBuffer(encrypted) || encrypted.length > LIMIT * 4) throw new Error("Invalid ciphertext.");
        checkDirectory(true); checkFile(file);
        for (const name of io.readdirSync(directory)) {
          if (!name.startsWith(tool + ".cred.tmp-")) continue;
          const stale = join(directory, name);
          try { const stat = io.lstatSync(stale); if (stat.isFile() && !stat.isSymbolicLink()) io.unlinkSync(stale); } catch { /* A locked leftover must not block the save. */ }
        }
        temp = file + ".tmp-" + randomBytes(16).toString("hex");
        descriptor = io.openSync(temp, "wx", 0o600);
        io.writeFileSync(descriptor, encrypted);
        io.fsyncSync(descriptor);
        io.closeSync(descriptor); descriptor = null;
        io.renameSync(temp, file);
        temp = null;
      } catch { throw new Error("Could not save credential safely."); }
      finally {
        if (descriptor !== null) { try { io.closeSync(descriptor); } catch {} }
        if (temp) { try { io.unlinkSync(temp); } catch {} }
      }
    },
    // Only a missing directory or file means "no key". Every other failure throws so the reply is ok:false.
    async get(tool) {
      try {
        const file = fileFor(tool);
        if (!available() || !checkDirectory()) return null;
        checkFile(file);
        const stat = io.statSync(file);
        if (stat.size > LIMIT * 4) throw new Error("Invalid credential size.");
        const json = safeStorage.decryptString(io.readFileSync(file));
        if (typeof json !== "string" || Buffer.byteLength(json) > LIMIT) throw new Error("Invalid credential size.");
        const record = JSON.parse(json); recordJson(record);
        return record;
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw new Error("Could not read credential safely.");
      }
    },
    async remove(tool) {
      try {
        const file = fileFor(tool);
        if (!checkDirectory()) return;
        checkFile(file);
        try { io.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      } catch { throw new Error("Could not remove credential safely."); }
    },
  };
}

export async function handleCliCredentialMessage(message, reply, store) {
  if (message?.type !== "cliCredentialRequest") return;
  const id = typeof message.id === "string" && message.id.length <= 64 ? message.id : "";
  let available = false, ok = false, record;
  try {
    available = store.available() === true;
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.id !== "string" || message.id.length > 64 || !toolValid(message.tool)) throw new Error("Invalid request.");
    const set = message.operation === "set";
    const fields = set ? ["type", "id", "operation", "tool", "record"] : ["type", "id", "operation", "tool"];
    if (!["set", "get", "remove"].includes(message.operation) || Object.keys(message).length !== fields.length || Object.keys(message).some((key) => !fields.includes(key))) throw new Error("Invalid request.");
    if (set) { recordJson(message.record); if (!available) throw new Error("Unavailable."); await store.set(message.tool, message.record); }
    else if (message.operation === "get") record = await store.get(message.tool);
    else await store.remove(message.tool);
    ok = true;
  } catch { /* Only the status crosses the private channel on failure. */ }
  try { reply({ type: "cliCredentialResult", id, available, ok, ...(ok && message.operation === "get" ? { record: record ?? null } : {}) }); } catch {}
}
