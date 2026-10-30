export const testsBrowserMutations = [
  ["guard-browser-harness-reply-wait-own-start","test/browser-harness/15-pack-three-2d.js","window.__received.slice(receivedFrom).some((message) => message.type === \"chatDone\" && message.tabId === sent[0].tabId), \"the reply to the plain Enter\"","window.__received.slice(from).some((message) => message.type === \"chatDone\"), \"the reply to the plain Enter\""],
  ["guard-browser-harness-reply-wait-own-start-chip","test/browser-harness/15-pack-three-2d.js","window.__received.slice(receivedFrom).some((message) => message.type === \"chatDone\" && message.tabId === sent[0].tabId), \"the reply to the chip\"","window.__received.slice(from).some((message) => message.type === \"chatDone\"), \"the reply to the chip\""],
  ["guard-browser-temp-removed-after-failed-stop","test/browser-real.test.ts","    try { await stopServer(child); } // a stop that rejects or times out still surfaces, after the temp folder is gone\n    finally { rmSync(temp, { recursive: true, force: true, maxRetries:30, retryDelay:100 }); }\n  }\n});","    await stopServer(child);\n    rmSync(temp, { recursive: true, force: true, maxRetries:30, retryDelay:100 });\n  }\n});"],
  ["guard-browser-cap-waits-for-helper-pid", "test/browser-guards.test.ts", "capMs: 2500, capStartsAfter: helperStarted, chrome", "capMs: 2500, chrome"],
  ["guard-browser-cap-armed-by-workload-promise", "test/browser-helpers.ts", "    if (args.capStartsAfter) args.capStartsAfter.then(arm,", "    if (false) args.capStartsAfter.then(arm,"],
  ["guard-browser-chrome-tree-kill", "test/chrome-stop.ts", "[\"/pid\", String(pid), \"/T\", \"/F\"]", "[\"/pid\", String(pid), \"/F\"]"],
  ["guard-browser-chrome-stop-retry", "test/chrome-stop.ts", "attempt <= 2", "attempt <= 1"],
  ["guard-pack7-r1-unlock-check-name","test/browser-harness/15-pack-three-2b.js","check(\"an open picker, seat card and Settings unlock when","check(\"RENAMED an open picker, seat card and Settings unlock when"],
];
