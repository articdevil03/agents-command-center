import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
// Isolated test server only. The real publication path fails once, after its
// durable task replacement, to leave a production startup recovery to finish.
if (process.env.CC_P26_RUN4_PRELOAD === "1") {
  const rename = fs.renameSync;
  let armed = false;
  fs.renameSync = (from, to) => {
    if (armed && String(to).replaceAll("\\", "/").endsWith("/executions/fixed.json")) {
      armed = false; throw new Error("Run 4 native journal publication interrupted");
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  process.on("message", (message: any) => {
    if (message?.run4Control !== "arm-prune") return;
    armed = true; process.send?.({ run4Reply: message.id });
  });
}
