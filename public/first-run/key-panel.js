// Catalog field descriptors and keySaved are the only source of key UI facts.
"use strict";
(() => {
  const SAVED = "Key saved. Connection checked when you first chat.";
  function create(page) {
    const panels = new Map(), pending = new Map();
    const facts = (cli) => page.state?.settings?.catalogTools?.[cli];
    const clear = (panel) => panel.querySelectorAll("input,select").forEach((input) => { input.value = ""; });
    const clearSecrets = (panel) => panel.querySelectorAll("[data-secret]").forEach((input) => { input.value = ""; });
    function busy(cli) {
      const request = pending.get(cli);
      return Boolean(request && !request.error && (!request.id || !page.actionStateFor(request.id) || page.actionStateFor(request.id).status === "running"));
    }
    function send(cli, panel, remove) {
      if (busy(cli)) return;
      const fields = {};
      if (!remove) for (const input of panel.querySelectorAll("[data-key-field]")) fields[input.dataset.keyField] = input.dataset.secret || input.tagName === "SELECT" ? input.value : input.value.trim();
      clearSecrets(panel); // Clear secrets before the send boundary, including failed or throwing sends.
      pending.set(cli, { id: null, remove });
      updateAll(cli);
      try {
        const id = page.sendSettingsAction(`cli-key-${cli}`, remove ? { type: "removeCliKey", cli } : { type: "submitCliKey", cli, fields });
        if (id) pending.set(cli, { id, remove });
        else pending.set(cli, { error: "Could not send. Try again.", remove });
      } catch { pending.set(cli, { error: "Could not send. Try again.", remove }); }
      finally { for (const key of Object.keys(fields)) delete fields[key]; }
      updateAll(cli);
    }
    function build(cli, surface) {
      const panel = document.createElement("div"); panel.className = "cli-key-panel";
      const status = document.createElement("p"); status.setAttribute("aria-live", "polite"); status.className = "cli-key-status";
      const actions = document.createElement("div"); actions.className = "cli-key-actions";
      const form = document.createElement("form"); form.autocomplete = "off"; form.className = "cli-key-fields";
      for (const field of facts(cli).keyProfile.fields) {
        const label = document.createElement("label"); label.className = "field";
        const title = document.createElement("span"); title.className = "lbl"; title.textContent = field.label;
        const input = document.createElement(field.kind === "choice" ? "select" : "input");
        input.className = "settings-input"; input.dataset.keyField = field.id;
        input.dataset.focusKey = `${surface}-key-${cli}-${field.id}`;
        if (field.kind === "secret") input.dataset.secret = "true";
        input.autocomplete = "off"; input.spellcheck = false;
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.kind === "choice") {
          const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose..."; input.append(placeholder);
          for (const choice of field.choices) { const option = document.createElement("option"); option.value = choice.value; option.textContent = choice.label; input.append(option); }
        } else { input.type = field.kind === "secret" ? "password" : "text"; input.maxLength = field.maxLength; }
        input.required = field.required === true;
        label.append(title, input); form.append(label);
      }
      function button(text, act, parent = actions) {
        const button = document.createElement("button"); button.type = "button"; button.className = "btn sm";
        button.textContent = text; button.dataset.keyAct = act; button.dataset.focusKey = `${surface}-key-${cli}-${act}`; parent.append(button); return button;
      }
      const open = () => { if (busy(cli)) return; pending.delete(cli); panel.dataset.open = "true"; clear(panel); update(cli, panel); form.querySelector("input")?.focus(); };
      button("Add key", "add").onclick = open;
      button("Replace key", "replace").onclick = open;
      button("Remove key", "remove").onclick = () => send(cli, panel, true);
      const formActions = document.createElement("div"); formActions.className = "cli-key-actions"; form.append(formActions);
      const save = button("Save key", "save", formActions); save.type = "submit"; save.classList.add("primary");
      button("Cancel", "cancel", formActions).onclick = () => {
        if (busy(cli)) return;
        pending.delete(cli); panel.dataset.open = "false"; clear(panel); update(cli, panel);
        panel.querySelector(`[data-key-act="${facts(cli)?.keySaved || facts(cli)?.keyUnreadable ? "replace" : "add"}"]`)?.focus();
      };
      form.addEventListener("submit", (event) => { event.preventDefault(); send(cli, panel, false); });
      panel.append(status, actions, form);
      return panel;
    }
    function update(cli, panel) {
      const request = pending.get(cli), result = request?.id ? page.actionStateFor(request.id) : null;
      const working = busy(cli), saved = facts(cli)?.keySaved === true, unreadable = facts(cli)?.keyUnreadable === true;
      const existing = saved || unreadable;
      if (result?.status === "done") { panel.dataset.open = "false"; clear(panel); }
      const status = panel.querySelector(".cli-key-status");
      status.textContent = request?.error || (result?.status === "failed" || result?.status === "unknown" ? result.message || "Could not save. Try again." : working ? "Saving..." : unreadable ? "The saved key for this tool cannot be read. Replace it or remove it here." : saved ? SAVED : "");
      const open = panel.dataset.open === "true";
      panel.querySelector("form").hidden = !open;
      for (const button of panel.querySelectorAll("button")) {
        button.disabled = working;
        const act = button.dataset.keyAct;
        button.hidden = act === "add" ? existing || open : act === "replace" ? !existing || open : act === "remove" ? !existing : false;
      }
    }
    function updateAll(cli) { for (const [key, panel] of panels) if (key.endsWith(":" + cli)) update(cli, panel); }
    function mount(root, surface) {
      for (const slot of root.querySelectorAll("[data-cli-key-slot]")) {
        const cli = slot.dataset.cliKeySlot, tool = facts(cli);
        if (tool?.installed !== true || !tool.keyProfile || (surface === "wizard" && tool.connection === "verified")) continue;
        const key = surface + ":" + cli;
        if (!panels.has(key)) panels.set(key, build(cli, surface));
        const panel = panels.get(key);
        if (panel.parentElement !== slot) slot.append(panel);
        update(cli, panel);
      }
    }
    // Removed/hidden surfaces must not keep a pasted value in retained DOM nodes.
    new MutationObserver(() => {
      for (const panel of panels.values()) if (!panel.isConnected || panel.closest("[hidden]")) clear(panel);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    return { mount };
  }
  window.CC_KEY_PANEL = Object.freeze({ create });
})();
