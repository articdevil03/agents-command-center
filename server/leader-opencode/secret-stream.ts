import type { LeaderCallbacks } from "../leader-common.ts";

export function createSecretStream(secrets: string[], cb: LeaderCallbacks) {
  // Streamed text is redacted too (a command the leader runs can print its own environment). A secret can be split across two deltas,
  // so the last few characters wait for the next delta and are released when the turn ends.
  // Redaction always sees the text exactly as OpenCode sent it: a paragraph break between two parts is only a mark (an index into the held text, shown before that character)
  // and becomes "\n\n" after redaction, so a secret split across two parts is still found.
  const holdBack = Math.max(0, ...secrets.map((secret) => secret.length)) - 1;
  const HIDDEN = "[hidden]";
  let pendingTail = "";
  let tailBreaks: number[] = [];
  function redactMarked(raw: string, marks: number[]): { text: string; marks: number[] } {
    const found: [number, number][] = [];
    for (const secret of secrets) if (secret) for (let at = raw.indexOf(secret); at >= 0; at = raw.indexOf(secret, at + secret.length)) found.push([at, at + secret.length]);
    const ranges: [number, number][] = [];
    for (const range of found.sort((a, b) => a[0] - b[0])) { const last = ranges.at(-1); if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]); else ranges.push([...range]); }
    let text = "", from = 0;
    for (const [start, end] of ranges) { text += raw.slice(from, start) + HIDDEN; from = end; }
    // A mark inside a hidden secret moves to the start of its [hidden].
    return { text: text + raw.slice(from), marks: marks.map((mark) => { let shift = 0; for (const [start, end] of ranges) { if (mark <= start) break; if (mark < end) { mark = start; break; } shift += HIDDEN.length - (end - start); } return mark + shift; }) };
  }
  // The text up to `end` with the paragraph breaks put in (a break at `end` itself only when `atEnd`).
  function withBreaks(text: string, marks: number[], end: number, atEnd: boolean): string {
    let out = "", from = 0;
    for (const mark of marks) { if (mark > end || (mark === end && !atEnd)) break; out += `${text.slice(from, mark)}\n\n`; from = mark; }
    return out + text.slice(from, end);
  }
  // Shows everything before `cut` and keeps the rest (and its breaks) held back.
  function release(held: { text: string; marks: number[] }, cut: number): void {
    const out = withBreaks(held.text, held.marks, cut, false);
    pendingTail = held.text.slice(cut);
    tailBreaks = held.marks.filter((mark) => mark >= cut).map((mark) => mark - cut);
    if (out) cb.onDelta(out);
  }
  function emitDelta(text: string, breakBefore = false): void {
    const joined = redactMarked(pendingTail + text, breakBefore ? [...tailBreaks, pendingTail.length] : tailBreaks);
    release(joined, joined.text.length - Math.min(holdBack, joined.text.length));
  }
  // How many characters at the end of `text` could be the start of a secret whose rest has not arrived.
  function secretPrefixLength(text: string): number {
    let keep = 0;
    for (const secret of secrets) for (let n = Math.min(secret.length - 1, text.length); n > keep; n--) if (secret.startsWith(text.slice(text.length - n))) { keep = n; break; }
    return keep;
  }
  // The end of the text (a stop, a death, the turn's end): nothing more arrives, so an end that is the start of a secret is never shown. From 4 characters on it is
  // shown as [hidden]; a shorter match is ordinary text.
  function flushTail(): void {
    const held = redactMarked(pendingTail, tailBreaks);
    pendingTail = ""; tailBreaks = [];
    const cut = secretPrefixLength(held.text);
    const out = cut >= 4 ? `${withBreaks(held.text, held.marks, held.text.length - cut, true)}${HIDDEN}` : withBreaks(held.text, held.marks, held.text.length, false);
    if (out) cb.onDelta(out);
  }
  // At a steer: everything held back is released through the same redaction, except an end that could still be the start of a secret (its rest has not arrived), which keeps waiting.
  function flushSafeTail(): void {
    const held = redactMarked(pendingTail, tailBreaks);
    release(held, held.text.length - secretPrefixLength(held.text));
  }
  return { emitDelta, flushTail, flushSafeTail };
}
