"use strict";

// Event wiring stays separate from core logic so interaction changes do not risk storage and migration code.
app.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;

  const action = target.dataset.action;
  const counterId = target.dataset.counterId;

  if (action === "select-board") setActiveBoard(target.dataset.boardId);
  if (action === "start-board-edit") startBoardNameEdit();
  if (action === "undo") undo();
  if (action === "copy-text") copyTextExport();
  if (action === "add-board") addBoard();
  if (action === "add-preset") addPresetBoard(target.dataset.presetKey);
  if (action === "add-counter") addCounter();
  if (action === "select-fighter") selectFighter(target.dataset.fighter || "");
  if (action === "quick-win") recordSmashResult("win");
  if (action === "quick-loss") recordSmashResult("loss");
  if (action === "clear-fighter-search") {
    state.fighterQuery = "";
    render();
    requestAnimationFrame(() => document.querySelector("[data-input='fighter-search']")?.focus());
  }
  if (action === "filter-fighter-group") {
    state.fighterGroup = target.dataset.group || "すべて";
    state.fighterQuery = "";
    render();
  }
  if (action === "filter-match-history") {
    state.matchHistoryFilter = target.dataset.filter || "all";
    state.matchHistoryLimit = 10;
    render();
  }
  if (action === "toggle-match-history") {
    const total = smashMatchHistory(activeBoard()).filter((match) => state.matchHistoryFilter === "all" || match.result === state.matchHistoryFilter).length;
    state.matchHistoryLimit = state.matchHistoryLimit < total ? state.matchHistoryLimit + 10 : 10;
    render();
  }
  if (action === "plus") changeCounter(counterId, 1);
  if (action === "minus") changeCounter(counterId, -1);
  if (action === "delete-counter") deleteCounter(counterId);
  if (action === "start-edit") startEdit(counterId, target.dataset.label || "");
  if (action === "finish-edit") finishEdit();
  if (action === "toggle-target-panel") toggleTargetPanel();
  if (action === "toggle-include") toggleIncludeInTotal(counterId);
  if (action === "target-all") applyTotalPreset("all");
  if (action === "target-none") applyTotalPreset("none");
  if (action === "reset") resetBoard();
  if (action === "clear-memo") clearMemoText();
  if (action === "delete-board") deleteActiveBoard();
  if (action === "import") fileInput.click();
});

app.addEventListener("keydown", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;

  if (event.key === "Enter" && input.dataset.input === "board-name") finishBoardNameEdit();
  if (event.key === "Escape" && input.dataset.input === "board-name") cancelBoardNameEdit();
  if (event.key === "Enter" && input.dataset.input === "new-board") addBoard();
  if (event.key === "Enter" && input.dataset.input === "new-counter") addCounter();
  if (event.key === "Enter" && input.dataset.input === "edit-counter") finishEdit();
  if (event.key === "Escape" && input.dataset.input === "edit-counter") {
    state.editingCounterId = null;
    state.draftLabel = "";
    render();
  }
});

app.addEventListener("input", (event) => {
  const input = event.target;
  if (input instanceof HTMLTextAreaElement && input.dataset.input === "memo") {
    updateMemo(input.value);
    return;
  }

  if (input instanceof HTMLInputElement) {
    if (input.dataset.input === "fighter-search") {
      state.fighterQuery = input.value;
      const selectionStart = input.selectionStart;
      render();
      requestAnimationFrame(() => {
        const next = document.querySelector("[data-input='fighter-search']");
        next?.focus();
        next?.setSelectionRange(selectionStart, selectionStart);
      });
      return;
    }
    if (input.dataset.input === "board-name") state.draftBoardName = input.value;
    if (input.dataset.input === "edit-counter") state.draftLabel = input.value;
    queueDraftSave();
  }
});

fileInput.addEventListener("change", () => importJson(fileInput.files[0]));

window.addEventListener("pagehide", saveDraftNow);
window.addEventListener("beforeunload", saveDraftNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveDraftNow();
});

window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY || !event.newValue) return;
  const normalized = normalizeImportedData(unwrapStoredPayload(safeParse(event.newValue)));
  if (!normalized) return;
  state.data = normalized;
  state.lastAction = null;
  state.editingCounterId = null;
  state.draftLabel = "";
  render();
  showToast("別タブの更新を反映しました");
});

runSelfTests();
render();

if (recoveredFromBackup) {
  setTimeout(() => showToast("バックアップから復元しました"), 240);
}
