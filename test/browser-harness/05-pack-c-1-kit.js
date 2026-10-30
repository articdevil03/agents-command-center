(() => {
  const { check, $, requireElement, confirmIfAsked } = window.__ccHarness;
  const settleMicrotasks = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  const deliver = (next, keepSeed = true) => { if (keepSeed) window.__ccSeed = structuredClone(next); window.__ccDeliver({ ...next, type: "state" }); };
  const deliverAction = (requestId, status, message) => {
    const next = structuredClone(window.__latestState);
    next.requestActions = { ...(next.requestActions ?? {}), [requestId]: { requestId, status, message } };
    deliver(next);
  };
  const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
  const openSettingsSection = (section) => {
    if ($("setModal").hidden) $("setBtn").click();
    requireElement(`#setNav [data-settings-section="${section}"]`).click();
    return requireElement(`#setBody #s-${section}`);
  };
  const makeSettingsAction = (markUnique) => {
    const settingsAction = async ({ name, section, selector, type, fields = {}, result = "failed", message = "Server refusal for this action" }) => {
      openSettingsSection(section);
      if (type === "mcpAdd") {
        const form = document.querySelector(`[data-mcp-form="${CSS.escape(fields.cli)}"]`);
        if (form?.hidden) requireElement(`[data-settings-add="mcp-${CSS.escape(fields.cli)}"]`).click();
      }
      if (type === "pluginInstall") {
        const form = requireElement("[data-plugin-form]");
        if (form.hidden) requireElement('[data-settings-add="plugins-claude"]').click();
      }
      const start = window.__sent.length;
      if (type === "setNotesVault") { requireElement("#vaultPath").value = fields.path ?? ""; requireElement("#vaultPath").dispatchEvent(new Event("input", { bubbles: true })); }
      if (type === "setDefaultProjectFolder") requireElement("#defaultProjectFolder").value = fields.folder ?? "";
      const button = requireElement(selector); const form = button.form;
      if (type === "mcpAdd" && form) { form.elements.name.value = fields.name; form.elements.commandOrUrl.value = fields.commandOrUrl; }
      if (type === "pluginInstall" && form) form.elements.name.value = fields.name;
      const buttonDisabledBeforeClick = button.disabled; const formValues = form ? { name: form.elements.name?.value, commandOrUrl: form.elements.commandOrUrl?.value, valid: form.checkValidity() } : null; button.focus(); button.click(); confirmIfAsked();
      await settleMicrotasks();
      const sent = window.__sent.slice(start).filter((item) => item.type === type).at(-1);
      const idGood = markUnique(sent?.requestId);
      const expectedFields = { type, ...fields };
      const exactMessage = Boolean(sent && idGood
        && Object.keys(sent).length === Object.keys(expectedFields).length + 1
        && Object.entries(expectedFields).every(([key, value]) => sent[key] === value)
        && Object.keys(sent).every((key) => key === "requestId" || Object.hasOwn(expectedFields, key)));
      const statusNode = sent?.requestId ? document.querySelector(`[data-status-for="${CSS.escape(sent.requestId)}"]`) : null;
      const runningShown = statusNode?.dataset.status === "running";
      const pendingButton = requireElement(selector);
      const disabledWhileRunning = pendingButton.disabled;
      if (sent?.requestId && type === "setNotesVault" && result === "done") {
        const next = structuredClone(window.__latestState);
        next.settings.vault.path = fields.path ?? null;
        next.requestActions = { ...(next.requestActions ?? {}), [sent.requestId]: { requestId: sent.requestId, status: result, message } };
        deliver(next);
      } else if (sent?.requestId) deliverAction(sent.requestId, result, message);
      const finalStatus = sent?.requestId ? document.querySelector(`[data-status-for="${CSS.escape(sent.requestId)}"]`) : null;
      const finalButton = requireElement(selector);
      const statusShown = finalStatus?.dataset.status === result && finalStatus.textContent.includes(message);
      const reenabled = !finalButton.disabled;
      const focusRestored = document.activeElement?.dataset.focusKey === button.dataset.focusKey;
      check(`${name} sends its exact request, shows that id's ${result} status, restores focus, and re-enables`, Boolean(sent) && exactMessage && runningShown && disabledWhileRunning && statusShown && reenabled && focusRestored, { sent: sent ?? null, expectedFields: { ...expectedFields, requestId: "<fresh unique request id>" }, exactMessage, buttonDisabledBeforeClick, buttonType: button.type, formValues, idGood, runningShown, disabledWhileRunning, finalStatus: finalStatus ? { id: finalStatus.dataset.statusFor, status: finalStatus.dataset.status, message: finalStatus.textContent } : null, statusShown, reenabled, focusRestored, activeFocusKey: document.activeElement?.dataset.focusKey });
      return sent;
    };
    return settingsAction;
  };
  Object.assign(window.__ccHarness, { settleMicrotasks, deliver, deliverAction, safeId, openSettingsSection, makeSettingsAction });
})();
