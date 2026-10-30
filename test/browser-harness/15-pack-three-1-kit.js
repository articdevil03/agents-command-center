(() => {
  const { latestTab, pressEscape } = window.__ccHarness;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tabId = "alpha-dev";
  const seedTab = (id = tabId) => latestTab(id, window.__ccSeed);
  const deliverSeed = () => window.__ccDeliver({ ...structuredClone(window.__ccSeed), type: "state" });
  const sentSince = (start, type) => window.__sent.slice(start).filter((message) => message.type === type);
  const closeAll = () => { for (let count = 0; count < 3; count++) pressEscape(); };
  const STOP_CONFIRM = "release may leave a process running and editing files", UNBLOCK_CONFIRM = "allow this seat to launch again";
  const coderName = () => seedTab().crew.find((seat) => seat.slot === "coder").name;
  Object.assign(window.__ccHarness, { sleep, tabId, seedTab, deliverSeed, sentSince, closeAll, STOP_CONFIRM, UNBLOCK_CONFIRM, coderName });
})();
