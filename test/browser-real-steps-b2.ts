import assert from "node:assert/strict";
import { join } from "node:path";
import { assertAuditFinished } from "./browser-constants.ts";
import { listen, chromeAudit } from "./browser-helpers.ts";
import type { BrowserProxy } from "./browser-real-types.ts";

export async function b2Audit(proxy: BrowserProxy, temp: string, folder: string) {
  const b2Port = await listen(proxy.proxy);
  const b2 = await chromeAudit({ port: b2Port, mode: "fake", folder, width: 1600, profile: join(temp, "chrome-b2"), caseName: "b2", collect: process.env.CC_BROWSER_COLLECT === "1", virtualMs: 35_000 });
  console.log(`Browser Pack B2 acceptance audit: ${JSON.stringify(b2)}`);
  assert.equal(b2.failures?.length ?? 0, 0, `B2 call-site mutation detected: ${(b2.failures ?? []).map((item: any) => item.name).join(" | ")}`);
  assert.equal(b2.failure, undefined, `Pack B2 browser audit failed: ${b2.failure ?? JSON.stringify(b2)}`);
  assertAuditFinished(b2, "b2");
  assert.deepEqual(b2.errors, [], `Pack B2 browser console/runtime errors: ${JSON.stringify(b2.errors)}`);
  const b2Names = b2.checks.map((item: any) => item.name);
  for (const name of [
    "Pack B2 target selector list finds every required control",
    "B1 labels, effort, role, CLI, and Nova portrait match the mockup",
    "the leader crown badge shows only when the leader's picture has no crown of its own",
    "Codex and OpenCode model labels use the mockup names and unknown ids are shown cleaned up, never raw",
    "XSS-shaped chat, tab, project, and folder strings stay visible literal text",
    "project rename keeps typed text through incoming state, Enter sends it, and Escape discards it",
    "Attach precedes the permission pill and keeps its file input",
    "launch safety panel stays hidden when there is no safety action",
    "launch safety shows the read-only warning only when the seat's CLI cannot enforce it",
    "tab arrows select the next tab and restore focus after re-render",
    "worker Live, History, run, and history-return controls retain focus after re-render",
    "approval card exposes the real approve action and prefilled changes",
    "Settings includes every mockup section and retains Behaviour defaults",
    "Behaviour switches send the selected values through the server protocol",
    "Settings closes and restores focus to its opener",
    "leader History requests saved files for the leader seat and returns to chat",
    "session row hides unmeasured or invalid context and shows a clamped one-decimal meter and saved time",
    "Save sends the tab, shows progress, handles success, and reports the matching error",
    "Clear always confirms, clears the transcript, restores once within 10 seconds, and reports rejected Undo",
    "notification policy covers worker finish, failure, stall (never launch), focus, approval, routine noise, and both kinds of stop (the server's own internal stop and the user's)",
    "disabling notifications blocks every desktop notice while the sound button keeps the chime on the same events",
    "clicking the speaker opens the sound popover under it; Escape, a click outside and a second click close it",
    "the sound popover's switch turns the completion chime off and on, in sync with Settings both ways",
    "the sound popover and the Settings switch agree before the server answers, from either one",
    "the volume slider shows its percent while dragged, keeps it through a state redraw, and sends the pref once when let go",
    "Test plays one bell at the slider's level, before it is let go and while the sound is off, and saves nothing",
    "every bell follows the saved volume: 30% is 0.3 of the full master level, 0% plays nothing, and the speaker shows muted at 0%",
    "an unread reply in a project that is not shown dots its tab until that project is opened",
    "the page shows the theme and picture a state carries, and an unknown preset falls back to Ash",
    "Dismiss saves the run on the server, and the page hides exactly the runs the server lists",
    "Your avatar has twenty presets, saves the choice to the server, and returns focus after a state re-render",
      "a picture over 512 KB is refused in plain words, sends nothing and keeps the old picture",
      "Your avatar upload stores the image data URL on the server and shows it through one short blob URL",
      "your uploaded picture is referenced once in each message, never copied into its HTML",
      "seat avatar presets and upload control render, send the selected picture and return focus after a state re-render",
      "active leader turn queues click and Enter without sending, and the next draft and image move into the queue",
      "background completion preserves foreground upload status and names background errors",
    "image-only composer stays disabled and retains its image",
    "completed leader turn clears progress and keeps the empty composer disabled",
    "chat waits for an in-flight image read before sending",
    "client send guard covers click and Enter",
    "pending send keeps text and attachments read-only until its request is answered",
    "chatMessage from another or legacy window cannot settle an identical draft",
    "chat error with another request id cannot settle this send",
    "chatMessage with my request id accepts and consumes only that composer snapshot",
    "chat consumes only the attachments in its send snapshot",
    "disconnected sends keep draft and attachments",
    "chat sends the uploaded image path for the selected tab",
    "chat image thumbnails include the sent filename as a file chip",
    "XSS-shaped attachment filenames stay visible literal text",
    "XSS-shaped run output stays visible literal text",
    "released attachments stop before POST when their file read finishes",
    "chat waits for image upload, sends its server path, renders the right-side thumbnail, and releases the preview",
    "assistant messages use the lead portrait, and every message's time label is the clock time of its `at`",
    "completed attachment resources release after a tab removal is confirmed",
    "completed attachment resources release after a project removal is confirmed",
    "a send waiting for an image is abandoned on tab switch and both drafts survive",
    "a send waiting for an image is abandoned on project switch and both drafts survive",
    "a send waiting for an image is abandoned on switch away and back and both drafts survive",
    "History matches out-of-order historyRun replies by seat and timestamp and ignores stale ones",
    "a failed Settings send rolls back with an error and reconnect shows the server's value",
    "Run dialog keeps the brief and shows an error when the send fails, then closes after a successful send",
    "selected-tab Undo restores selection when fallback state is delayed",
    "one rejected held removal restores only itself; the next removal cleans up on confirmation",
    "multiple held actions each keep a visible Undo when pagehide sends fail",
    "pagehide flushes every held action after reconnect",
    "error toast visibility and hidden state stay in sync",
    "Undo after Remove tab keeps a tab the user chose during the hold",
    "Undo after Remove tab returns to the removed tab when the user did not move",
    "Undo after Remove tab keeps the fallback tab the user clicked",
    "Undo after Remove tab keeps the fallback tab picked with the arrow keys",
    "Undo after Remove tab keeps the fallback tab picked with Enter",
    "Undo after Remove tab keeps the fallback tab picked with Space",
    "Undo after Remove tab keeps the fallback tab picked with the waiting card",
    "Undo after Remove tab keeps the fallback tab picked with the project picker",
    "unrelated errors never restore a held action",
    "an error naming the held request restores only that action",
    "chat error with my request id unlocks without changing the composer",
    "a refused chat unlocks Send once the server answers",
    "a disconnect mid-reply unlocks Send after reconnect with an idle server",
    "socket close releases pending lock but leaves composer text and attachments",
    "reconnect history without my request id keeps composer untouched",
    "reconnect history with my request id clears the accepted composer",
    "older accepted request cannot change a newer pending composer",
    "the send mode follows the leader turn: queues while active, plain Send with a worker still running and no chatDone",
    "a leader turn the server reports makes Send queue with no local send (second window or reconnect mid-turn)",
    "a state before server acceptance keeps the pending send locked with its composer intact",
    "a refusal during another window's turn leaves Send in queue mode",
    "a refused send leaves its original text and images in the composer",
    "a sent chat abandoned by a tab switch is still settled by its later echo without a duplicate send",
    "a sent chat abandoned by a tab switch is still settled by history on return without a duplicate send",
    "text edited after a disconnect survives reconnect history that accepts the older send",
    "a file picked while a send is pending is never attached to that composer",
    "the composer caps attachments at the server's eight-image limit",
  ]) assert.ok(b2Names.includes(name), `missing Pack B2 browser check ${name}; matched ${JSON.stringify(b2Names)}`);
  for (const kind of ["tab", "project", "process"]) {
    for (const order of ["read-before-undo", "read-after-undo"]) {
      const filename = `race-${kind}-${order}.png`;
      assert.ok(b2Names.includes(`attachment ${filename} survives the ${kind} Undo in ${order}`), `missing attachment Undo check ${filename}; matched ${JSON.stringify(b2Names)}`);
    }
    assert.ok(b2Names.includes(`attachment preview stays live while ${kind} Undo is pending`), `missing live Undo retention check for ${kind}; matched ${JSON.stringify(b2Names)}`);
  }
  assert.equal(b2Names.filter((name: string) => name.startsWith("removed completed attachment ")).length, 6, `each removal target was checked: ${JSON.stringify(b2Names.filter((name: string) => name.startsWith("removed completed attachment ")))}`);
}
