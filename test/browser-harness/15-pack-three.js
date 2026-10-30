(() => {
  const { collectFailures, check, waitFor, showChat, sleep, deliverSeed, closeAll, runPackThreeA, runPackThreeB, runPackThreeC, runPackThreeD } = window.__ccHarness;
  // Fix pack 3, block 2: page behaviour that had no test at all. Each part builds its own state from the seed, drives the real page code and puts the seed back.
  // With ?collect=1 a part that throws is recorded as one failed check and the next part still runs (the mutation proof breaks every handler at once and reads the failures).
  const runPackThree = async () => {
    await waitFor(() => window.__latestState?.type === "state", "pack 3 fake state");
    const pristine = structuredClone(window.__ccSeed);
    const resetSeed = async () => { closeAll(); window.__ccSeed = structuredClone(pristine); deliverSeed(); showChat(); await sleep(20); };
    const part = async (label, body) => {
      try { await body(); }
      catch (error) { if (!collectFailures) throw error; check(`${label}: ran to its end`, false, { error: String(error?.message ?? error) }); }
      await resetSeed();
    };

    await runPackThreeA(part);
    await runPackThreeB(part);
    await runPackThreeC(part);
    await runPackThreeD(part);
  };
  Object.assign(window.__ccHarness, { runPackThree });
})();
