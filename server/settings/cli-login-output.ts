import { stripVTControlCharacters } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { loginProfile, validateLoginUrl } from "./cli-login-policy.js";
export type LoginProgress = { verificationUrl: string | null; deviceCode: string | null; pasteRequired: boolean };
export class LoginOutput {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private bytes = 0;
  private ignored = false;
  readonly progress: LoginProgress = { verificationUrl: null, deviceCode: null, pasteRequired: false };
  private cli: string;
  constructor(cli: string) { this.cli = cli; }
  consumePaste(): void { this.progress.pasteRequired = false; this.buffer = ""; this.ignored = true; }
  clear(): void { this.decoder = new StringDecoder("utf8"); this.buffer = ""; this.progress.verificationUrl = null; this.progress.deviceCode = null; this.progress.pasteRequired = false; }
  feed(chunk: Buffer | string): LoginProgress {
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > 1024 * 1024) throw new Error("outputLimit");
    // After paste, ignore possible credential echo. No transcript leaves this parser.
    if (this.ignored) {
      const prompt = "Paste code here if prompted";
      const text = this.buffer + stripVTControlCharacters(this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      if (text.includes(prompt)) { this.buffer = ""; this.ignored = false; this.progress.pasteRequired = true; }
      else {
        this.buffer = "";
        for (let size = Math.min(prompt.length - 1, text.length); size > 0; size--) {
          if (text.endsWith(prompt.slice(0, size))) { this.buffer = prompt.slice(0, size); break; }
        }
      }
      return this.progress;
    }
    this.buffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const clean = stripVTControlCharacters(this.buffer).replace(/\r/g, "\n");
    const profile = loginProfile(this.cli);
    const prompt = profile.prompt?.exec(clean);
    if (prompt) {
      const envelope = clean.slice(prompt.index);
      for (const match of envelope.matchAll(/\b(?:https?|ftp):\/\/[^\s<>"']+/gi)) {
        // A URL split across chunks is evaluated only when delimited, or at flush.
        if (match.index! + match[0].length === envelope.length) continue;
        const url = validateLoginUrl(this.cli, match[0]);
        if (!url || (this.progress.verificationUrl && this.progress.verificationUrl !== url)) throw new Error("unsafeOutput");
        this.progress.verificationUrl = url;
      }
      const code = profile.codePrompt?.exec(envelope)?.[1];
      if (code) {
        if (!profile.code?.test(code)) {
          if (/\s$/.test(envelope)) throw new Error("unsafeOutput");
        } else if (this.progress.deviceCode && this.progress.deviceCode !== code) throw new Error("unsafeOutput");
        else this.progress.deviceCode = code;
      }
    }
    if (profile.paste && /Paste code here if prompted[^\n]*[>:]?/i.test(clean)) this.progress.pasteRequired = true;
    // Process first, then keep only the bounded incremental tail.
    if (Buffer.byteLength(this.buffer) > 8192) this.buffer = Buffer.from(this.buffer).subarray(-4096).toString("utf8");
    return this.progress;
  }
  flush(): LoginProgress { return this.feed("\n"); }
}
