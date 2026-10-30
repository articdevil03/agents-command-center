(() => {
  const { waitFor, installTenSecondClock, b2SeatsAndSettings, b2LeaderHistoryAndUndo, b2NotificationsAndBell, b2UnreadAndAvatars, b2AttachmentsAndReplies, b2UndoRacesAndSends, b2SwitchesAndRemovals, b2SendLockAndCaps } = window.__ccHarness;
  const runB2 = async () => {
    await waitFor(() => window.__latestState?.type === "state", "Pack B2 fake state");
    const holdClock = installTenSecondClock();
    const ctx = { holdClock };
    await b2SeatsAndSettings(ctx);
    await b2LeaderHistoryAndUndo(ctx);
    await b2NotificationsAndBell(ctx);
    await b2UnreadAndAvatars(ctx);
    await b2AttachmentsAndReplies(ctx);
    await b2UndoRacesAndSends(ctx);
    await b2SwitchesAndRemovals(ctx);
    await b2SendLockAndCaps(ctx);
    return { entry: ctx.entry, tabOf: ctx.tabOf };
  };
  Object.assign(window.__ccHarness, { runB2 });
})();
