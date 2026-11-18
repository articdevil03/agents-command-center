// Confirmation requests and their input gestures. Shared classic-script scope.
  "use strict";
  const confirmationQueue = [];
  let activeConfirmation = null, confirmationTimer = 0;
  let confirmationPress = null, confirmationKey = null;
  function confirmAction(options, callback, opener = document.activeElement, onCancel = null) {
    confirmationQueue.push({ options, callback, opener, onCancel });
    showNextConfirmation();
  }
  function showNextConfirmation() {
    if (activeConfirmation || confirmationTimer || !confirmationQueue.length) return;
    const request = activeConfirmation = confirmationQueue.shift();
    request.settleUntil = performance.now() + APPROVAL_SETTLE_MS;
    const { title, body, ok = "OK", cancel = "Cancel", danger = false, phrase = "" } = request.options;
    $("confirmTitle").textContent = title; $("confirmBody").textContent = body;
    $("confirmPhraseField").hidden = !phrase; $("confirmPhrase").value = ""; $("confirmPhrase").dataset.phrase = phrase;
    $("confirmPhraseLabel").innerHTML = phrase ? `Type <b>${esc(phrase)}</b> to confirm` : "";
    $("confirmErr").textContent = "";
    $("confirmOk").textContent = ok; $("confirmOk").className = `btn ${danger ? "danger" : "primary"}`;
    $("confirmCancel").textContent = cancel;
    openModal("confirmModal", request.opener);
    confirmCallback = request.callback; confirmCancelled = request.onCancel;
    if (phrase) $("confirmPhrase").focus();
  }
  // Retire before calling user code: callbacks can themselves enqueue another question.
  function confirmationClosed() {
    const cancelled = confirmCancelled;
    confirmCallback = null; confirmCancelled = null; activeConfirmation = null;
    confirmationTimer = setTimeout(() => { confirmationTimer = 0; showNextConfirmation(); }, 0);
    cancelled?.();
  }
  function confirmGestureAllowed(event) {
    const request = activeConfirmation;
    if (!request) return false;
    // Programmatic callers have no physical gesture. Native input uses the same settle
    // window and held-key/pointer tracking as tool approvals, including voice clicks.
    if (!event?.isTrusted) return true;
    if (performance.now() < request.settleUntil || event.repeat || event.detail > 1) return false;
    const press = event.type === "keydown" ? confirmationKey : event.detail ? confirmationPress : confirmationKey ?? confirmationPress;
    if (press !== null) return press === request;
    return !heldApprovalKeys.size && !heldApprovalPointers.size;
  }
  document.addEventListener("pointerdown", () => { confirmationPress = activeConfirmation && performance.now() >= activeConfirmation.settleUntil ? activeConfirmation : false; }, true);
  for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, () => {
    const request = confirmationPress;
    setTimeout(() => { if (confirmationPress === request) confirmationPress = null; }, 0);
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!["Enter", " ", "Escape"].includes(event.key) || !activeConfirmation) return;
    if (!event.repeat) confirmationKey = performance.now() >= activeConfirmation.settleUntil ? activeConfirmation : false;
    if (!confirmGestureAllowed(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener("keyup", () => {
    const request = confirmationKey;
    setTimeout(() => { if (confirmationKey === request) confirmationKey = null; }, 0);
  }, true);
  window.addEventListener("blur", () => { confirmationPress = null; confirmationKey = null; });
  function confirmAccepted(event) {
    if (!confirmGestureAllowed(event)) return;
    const input = $("confirmPhrase"), phrase = input.dataset.phrase;
    if (phrase && input.value.trim() !== phrase) { $("confirmErr").textContent = "Type the words exactly as shown"; input.focus(); return; }
    const callback = confirmCallback, typed = input.value.trim();
    confirmCallback = null; confirmCancelled = null;
    setLayer($("confirmModal"), false, null, true);
    callback?.(typed);
  }
