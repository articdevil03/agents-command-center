import { delay, J, skipped } from "./pack18-editor-harness.ts";
import { withFixedBehaviour, type Page } from "./fixed-page-behaviour.ts";

// Pack 9, the page side of the folder warning: the real page in a real headless Chrome, now on the shared fixed-crew behaviour page
// (test/fixed-page-behaviour.ts, two fixed tabs, the server's own discovered state). A `folderBusy` from the server shows
// "Another agent is working in this folder" with Continue anyway and Cancel; the held chat or Run keeps its draft, brief and attachments.
// With CC_PACK9_SHOTS=<folder> the dialogs and the leader notice are saved there as PNGs.

export { delay, J, skipped, type Page };
export const withPage = withFixedBehaviour;
export const dialog = `(()=>{const m=document.querySelector("#confirmModal");return m&&!m.hidden?{title:m.querySelector("#confirmTitle").textContent,body:m.querySelector("#confirmBody").textContent,ok:m.querySelector("#confirmOk").textContent,cancel:m.querySelector("#confirmCancel").textContent}:null})()`;
