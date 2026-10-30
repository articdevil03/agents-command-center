(() => {
  const { waitFor, safeId, makeSettingsAction, checkSettingsTargetsAndScroll, seedSettingsState, checkRequestBadgeAndLowerPanes, checkSettingsActions, checkObsidianOpen, checkRequestsDrawer, checkPermissionPicker, checkUploadsAndScreenshots, checkFileAttachments } = window.__ccHarness;
  const runPackC = async () => {
    await waitFor(() => window.__latestState?.type === "state", "Pack C fake state");
    await checkSettingsTargetsAndScroll();
    seedSettingsState();
    const seenRequestIds = new Set();
    const markUnique = (value) => { const unique = safeId(value) && !seenRequestIds.has(value); if (unique) seenRequestIds.add(value); return unique; };
    const settingsAction = makeSettingsAction(markUnique);
    await checkRequestBadgeAndLowerPanes();
    await checkSettingsActions(settingsAction);
    await checkObsidianOpen();
    const devLeader = checkRequestsDrawer(markUnique);
    checkPermissionPicker(markUnique, devLeader);
    const { uploadRequests, nativeFetch } = await checkUploadsAndScreenshots();
    await checkFileAttachments(uploadRequests);

    window.fetch = nativeFetch;
    return { ids: [...seenRequestIds], uploads: uploadRequests.map((item) => ({ path: item.path, requestId: item.requestId, fileName: item.fileName })) };
  };
  Object.assign(window.__ccHarness, { runPackC });
})();
