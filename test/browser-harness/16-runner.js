(() => {
  const { audit, auditNode, query, waitFor, runReal, runFake, runB2, runPackC, runRequestsReal, runPackCSettingsReal, runLayout, runToolApprovals, runR6Fixes, runR7Fixes, runR1Fixes, runLooksWrite, runLooksRead, runWindowButtons, runPackTwo, runPackThree, collisionAudit } = window.__ccHarness;
  const selected = query.get("case") || "all";
  (async () => {
    collisionAudit();
    if ((audit.mode === "real" || audit.mode === "fake") && (selected === "all" || selected === "render")) {
      if (audit.mode === "real") await runReal(); else await runFake();
    }
    if (audit.mode === "fake" && selected === "b2") await runB2();
    if (audit.mode === "fake" && selected === "pack2") await runPackTwo();
    if (audit.mode === "fake" && selected === "pack3") await runPackThree();
    if (audit.mode === "fake" && selected === "titlebar") await runWindowButtons();
    if (audit.mode === "fake" && selected === "c2") { await runPackC(); await runToolApprovals(); await runR6Fixes(); await runR7Fixes(); await runR1Fixes(); }
    if (audit.mode === "fake" && selected === "dialog-close") {
      await waitFor(() => window.__latestState?.type === "state", "dialog-close fake state");
      window.__ccDialogAuditReady = true;
      await new Promise((resolve) => { window.__ccDialogAuditContinue = resolve; });
    }
    if (audit.mode === "real" && selected === "looks-write") await runLooksWrite();
    if (audit.mode === "real" && selected === "looks-read") await runLooksRead();
    if (audit.mode === "real" && selected === "c2-settings") await runPackCSettingsReal();
    if (audit.mode === "real" && selected === "c2-requests") await runRequestsReal();
    if (selected === "all" || selected === "layout") await runLayout();
  })().then(() => {
    audit.finished = true; // the host test refuses a report without it: a virtual-time budget that ended the audit early leaves checks and no failure
    window.__auditReport = audit;
    auditNode.hidden = false;
    auditNode.textContent = JSON.stringify(audit);
    window.__auditDone = true;
    window.__ccAuditFinished = true;
    window.__socket?.close();
  }).catch((error) => {
    audit.failure = error?.stack ?? String(error);
    audit.matched.sent = (window.__sent ?? []).map((message) => { const size = JSON.stringify(message).length; return size > 2000 ? { type: message.type, key: message.key, truncatedFrom: size } : message; }); // a sent picture is megabytes of text
    audit.matched.stateCount = window.__states?.length ?? 0;
    audit.matched.errors = [...audit.errors];
    if (!audit.errors.some((item) => item.includes(error?.message ?? ""))) audit.errors.push(error?.message ?? String(error));
    window.__auditReport = audit;
    auditNode.hidden = false;
    auditNode.textContent = JSON.stringify(audit);
    window.__auditDone = true;
    window.__ccAuditFinished = true;
    window.__socket?.close();
  });
})();
