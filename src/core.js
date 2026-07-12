"use strict";

// ES modules are intentionally avoided so the app still opens in simple static previews and older embedded browsers.

const STORAGE_KEY = "pocket-count-standalone-v4";
const BACKUP_KEY = `${STORAGE_KEY}:backup`;
const SECOND_BACKUP_KEY = `${STORAGE_KEY}:backup2`;
const DRAFT_KEY = `${STORAGE_KEY}:draft`;
const SAVE_SCHEMA_VERSION = 5;

// 表示順を明示的に固定し、端末やブラウザの照合順に左右されないようにする。
let lastSavedText = "";
let draftSaveTimer = null;
let recoveredFromBackup = "";

const state = {
  data: loadData(),
  lastAction: null,
  editingCounterId: null,
  draftLabel: "",
  toastTimer: null,
  inputDraft: loadInputDraft(),
  restoredInputDraft: false,
  targetSettingsOpen: false,
  editingBoardName: false,
  draftBoardName: "",
  fighterQuery: "",
  fighterGroup: "すべて",
  matchHistoryFilter: "all",
  matchHistoryLimit: 10,
  matchHistoryOpen: false,
  lastMatchFeedback: null,
};

const app = document.getElementById("app");
const toast = document.getElementById("toast");
const fileInput = document.getElementById("fileInput");

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function makeCounter(label = "カウント", value = 0, memo = "", includeInTotal = true) {
  return { id: uid(), label, value, memo, includeInTotal };
}

function makeBoard(name = "新しいボード", counters = [makeCounter()], mode = "standard") {
  return { id: uid(), name, memo: "", counters, history: [], mode, selectedFighter: "" };
}

function createInitialData() {
  const board = makeBoard("今日のカウント", [makeCounter("カウント", 0, "", true)]);
  return { boards: [board], activeBoardId: board.id };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clampCount(value) {
  const number = Number(value);
  return Math.max(0, Number.isFinite(number) ? number : 0);
}

function calcAllTotal(counters = []) {
  return counters.reduce((sum, counter) => sum + clampCount(counter.value), 0);
}

function calcTargetTotal(counters = []) {
  return counters.reduce((sum, counter) => {
    if (counter.includeInTotal === false) return sum;
    return sum + clampCount(counter.value);
  }, 0);
}

function countTargetCounters(counters = []) {
  return counters.filter((counter) => counter.includeInTotal !== false).length;
}

function getTopCounter(counters = []) {
  if (!counters.length) return null;
  return counters.reduce((top, counter) => {
    if (!top) return counter;
    return clampCount(counter.value) > clampCount(top.value) ? counter : top;
  }, null);
}

function getTargetStreak(board) {
  if (!board || !Array.isArray(board.history)) return null;
  const includedCounters = new Map(
    board.counters
      .filter((counter) => counter.includeInTotal !== false)
      .map((counter) => [counter.id, counter])
  );
  if (includedCounters.size === 0) return null;

  const targetHistory = board.history.filter((event) => includedCounters.has(event.counterId));
  if (targetHistory.length === 0) return null;

  const last = targetHistory[targetHistory.length - 1];
  const lastCounter = includedCounters.get(last.counterId);
  if (!lastCounter) return null;

  let count = 0;
  for (let i = targetHistory.length - 1; i >= 0; i -= 1) {
    if (targetHistory[i].counterId !== last.counterId) break;
    count += 1;
  }

  return { counterId: last.counterId, label: lastCounter.label, count };
}

function formatStreak(streak) {
  if (!streak) return "—";
  if (streak.label.includes("勝")) return `${streak.count}連勝`;
  if (streak.label.includes("負")) return `${streak.count}連敗`;
  return `${streak.label} ${streak.count}連続`;
}

function appendHistory(history, counterId, count, fighter = "") {
  const next = Array.isArray(history) ? [...history] : [];
  for (let i = 0; i < count; i += 1) {
    next.push({ counterId, at: new Date().toISOString(), fighter });
  }
  return next.slice(-1000);
}

function removeLatestHistory(history, counterId, count) {
  const next = Array.isArray(history) ? [...history] : [];
  for (let n = 0; n < count; n += 1) {
    const index = next.map((event) => event.counterId).lastIndexOf(counterId);
    if (index === -1) break;
    next.splice(index, 1);
  }
  return next;
}

function applyCounterChangeToBoard(board, counterId, diff) {
  const result = changeCounterValue(board.counters, counterId, diff);
  let history = Array.isArray(board.history) ? board.history : [];

  if (result.actualDiff > 0) {
    history = appendHistory(history, counterId, result.actualDiff, board.mode === "smash" ? board.selectedFighter : "");
  }

  if (result.actualDiff < 0) {
    history = removeLatestHistory(history, counterId, Math.abs(result.actualDiff));
  }

  return { ...board, counters: result.counters, history };
}

function changeCounterValue(counters, counterId, diff) {
  let actualDiff = 0;
  const nextCounters = counters.map((counter) => {
    if (counter.id !== counterId) return counter;
    const before = clampCount(counter.value);
    const after = clampCount(before + diff);
    actualDiff = after - before;
    return { ...counter, value: after };
  });
  return { counters: nextCounters, actualDiff };
}

function normalizeImportedData(value) {
  const imported = value && value.data ? value.data : value;
  if (!imported || !Array.isArray(imported.boards) || imported.boards.length === 0) return null;

  const boards = imported.boards.map((board) => {
    const counters = Array.isArray(board.counters)
      ? board.counters.map((counter) => ({
          id: counter.id || uid(),
          label: String(counter.label || "カウント"),
          value: clampCount(counter.value || 0),
          memo: String(counter.memo || ""),
          includeInTotal: counter.includeInTotal !== false,
        }))
      : [];

    return {
      id: board.id || uid(),
      name: String(board.name || "無題"),
      memo: String(board.memo || ""),
      counters: counters.length ? counters : [makeCounter()],
      history: Array.isArray(board.history)
        ? board.history.map((event) => ({
            counterId: String(event.counterId || ""),
            at: String(event.at || new Date().toISOString()),
            fighter: SMASH_FIGHTERS.includes(String(event.fighter || "")) ? String(event.fighter) : "",
          })).filter((event) => event.counterId)
        : [],
      mode: board.mode === "smash" ? "smash" : "standard",
      selectedFighter: SMASH_FIGHTERS.includes(String(board.selectedFighter || "")) ? String(board.selectedFighter) : "",
    };
  });

  const activeBoardId = boards.some((board) => board.id === imported.activeBoardId)
    ? imported.activeBoardId
    : boards[0].id;

  return { boards, activeBoardId };
}

function unwrapStoredPayload(value) {
  if (!value) return null;
  return value.data || value;
}

function readStoredData(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const parsed = safeParse(raw);
  return normalizeImportedData(unwrapStoredPayload(parsed));
}

function loadData() {
  const candidates = [STORAGE_KEY, BACKUP_KEY, SECOND_BACKUP_KEY, DRAFT_KEY];

  for (const key of candidates) {
    const normalized = readStoredData(key);
    if (normalized) {
      if (key !== STORAGE_KEY) recoveredFromBackup = key;
      return normalized;
    }
  }

  return createInitialData();
}

function serializeSavePayload() {
  return JSON.stringify({
    app: "Pocket Count",
    schemaVersion: SAVE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    data: state.data,
  });
}

function saveData() {
  try {
    const nextText = serializeSavePayload();
    if (nextText === lastSavedText) return true;

    const current = localStorage.getItem(STORAGE_KEY);
    const backup = localStorage.getItem(BACKUP_KEY);

    if (backup) localStorage.setItem(SECOND_BACKUP_KEY, backup);
    if (current) localStorage.setItem(BACKUP_KEY, current);

    localStorage.setItem(STORAGE_KEY, nextText);
    lastSavedText = nextText;
    return true;
  } catch {
    showToast("保存容量がいっぱいかもしれません");
    return false;
  }
}

function loadInputDraft() {
  const parsed = safeParse(localStorage.getItem(DRAFT_KEY));
  if (!parsed || !parsed.inputDraft || !parsed.savedAt) return null;

  const ageMs = Date.now() - new Date(parsed.savedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > 1000 * 60 * 60 * 24) return null;

  return parsed.inputDraft;
}

function activeBoard() {
  return state.data.boards.find((board) => board.id === state.data.activeBoardId) || state.data.boards[0];
}

function getInputDraft() {
  return {
    activeBoardId: state.data.activeBoardId,
    newBoardName: document.querySelector("[data-input='new-board']")?.value || "",
    newCounterName: document.querySelector("[data-input='new-counter']")?.value || "",
    editCounterId: state.editingCounterId,
    editCounterLabel: document.querySelector("[data-input='edit-counter']")?.value || state.draftLabel || "",
    memo: document.querySelector("[data-input='memo']")?.value || activeBoard()?.memo || "",
  };
}

function saveDraftNow() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      app: "Pocket Count Draft",
      savedAt: new Date().toISOString(),
      data: state.data,
      inputDraft: getInputDraft(),
    }));
  } catch {
    // 下書き保存は補助機能なので、容量不足時も操作を止めない
  }
}

function queueDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraftNow, 120);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 1400);
}

function vibrate(ms = 8) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

function restoreInputDraftOnce() {
  if (state.restoredInputDraft || !state.inputDraft) return;
  const draft = state.inputDraft;

  const newBoardInput = document.querySelector("[data-input='new-board']");
  const newCounterInput = document.querySelector("[data-input='new-counter']");
  const memoInput = document.querySelector("[data-input='memo']");

  if (newBoardInput && draft.newBoardName) newBoardInput.value = draft.newBoardName;
  if (newCounterInput && draft.newCounterName) newCounterInput.value = draft.newCounterName;
  if (memoInput && draft.memo && draft.activeBoardId === state.data.activeBoardId) memoInput.value = draft.memo;

  if (draft.editCounterId && draft.editCounterLabel) {
    const board = activeBoard();
    const counter = board.counters.find((item) => item.id === draft.editCounterId);
    if (counter) {
      state.editingCounterId = draft.editCounterId;
      state.draftLabel = draft.editCounterLabel;
      state.inputDraft = null;
      state.restoredInputDraft = true;
      render();
      showToast("編集中の内容を復元しました");
      return;
    }
  }

  state.restoredInputDraft = true;
  if (draft.newBoardName || draft.newCounterName) showToast("入力途中の内容を復元しました");
}

function setActiveBoard(boardId) {
  state.data.activeBoardId = boardId;
  state.editingCounterId = null;
  state.draftLabel = "";
  state.editingBoardName = false;
  state.draftBoardName = "";
  state.targetSettingsOpen = false;
  state.fighterQuery = "";
  state.fighterGroup = "すべて";
  state.matchHistoryFilter = "all";
  state.matchHistoryLimit = 10;
  state.matchHistoryOpen = false;
  state.lastMatchFeedback = null;
  saveData();
  render();
}

function toggleTargetPanel() {
  state.targetSettingsOpen = !state.targetSettingsOpen;
  render();
}

function startBoardNameEdit() {
  const board = activeBoard();
  state.editingBoardName = true;
  state.draftBoardName = board.name;
  render();
  requestAnimationFrame(() => {
    const input = document.querySelector("[data-input='board-name']");
    if (input) {
      input.focus();
      input.select();
    }
  });
}

function finishBoardNameEdit() {
  const board = activeBoard();
  const input = document.querySelector("[data-input='board-name']");
  const name = (input?.value || state.draftBoardName || "").trim();
  state.editingBoardName = false;
  state.draftBoardName = "";
  if (!name) {
    render();
    return;
  }
  updateBoard(board.id, (current) => ({ ...current, name }));
  showToast("ボード名を変更しました");
}

function cancelBoardNameEdit() {
  state.editingBoardName = false;
  state.draftBoardName = "";
  render();
}

function updateBoard(boardId, updater) {
  state.data.boards = state.data.boards.map((board) => board.id === boardId ? updater(board) : board);
  saveData();
  render();
}

function changeCounter(counterId, diff) {
  const board = activeBoard();
  if (board.mode === "smash" && diff > 0 && !board.selectedFighter) {
    showToast("先に対戦相手を選んでください");
    document.querySelector(".fighter-search")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const result = changeCounterValue(board.counters, counterId, diff);
  if (result.actualDiff === 0) return;

  const targetCounter = board.counters.find((counter) => counter.id === counterId);
  const isSmashResult = board.mode === "smash"
    && diff > 0
    && board.selectedFighter
    && targetCounter
    && (targetCounter.label.includes("勝") || targetCounter.label.includes("負"));
  const feedback = isSmashResult
    ? { boardId: board.id, fighter: board.selectedFighter, result: targetCounter.label.includes("勝") ? "勝ち" : "負け" }
    : null;

  vibrate(diff > 0 ? 7 : 12);
  state.lastAction = { boardId: board.id, counterId, diff: result.actualDiff };
  if (feedback) {
    state.lastMatchFeedback = feedback;
    state.fighterQuery = "";
  }
  updateBoard(board.id, (current) => {
    const updated = applyCounterChangeToBoard(current, counterId, diff);
    return feedback ? { ...updated, selectedFighter: "" } : updated;
  });
  if (feedback) showToast(`${feedback.fighter}戦の${feedback.result}を記録しました`);
}

function undo() {
  if (!state.lastAction) return;
  const action = state.lastAction;
  state.lastAction = null;
  state.lastMatchFeedback = null;
  vibrate(20);
  updateBoard(action.boardId, (board) => applyCounterChangeToBoard(board, action.counterId, -action.diff));
  showToast("直前の操作を戻しました");
}

function addBoardFromValues(name, counters, memo = "", mode = "standard") {
  const board = makeBoard(name, counters.map((counter) => makeCounter(counter.label, 0, "", counter.includeInTotal !== false)), mode);
  board.memo = memo;
  state.data.boards.push(board);
  state.data.activeBoardId = board.id;
  state.lastAction = null;
  saveData();
  render();
  showToast("ボードを追加しました");
}

function addBoard() {
  const input = document.querySelector("[data-input='new-board']");
  const name = (input?.value || "").trim();
  if (!name) return;
  addBoardFromValues(name, [{ label: "カウント", includeInTotal: true }]);
}

function addPresetBoard(presetKey) {
  const preset = PRESETS.find((item) => item.key === presetKey);
  if (!preset) return;
  addBoardFromValues(preset.name, preset.counters, preset.memo, preset.key === "smash" ? "smash" : "standard");
}

function selectFighter(name) {
  if (!SMASH_FIGHTERS.includes(name)) return;
  const board = activeBoard();
  state.lastMatchFeedback = null;
  updateBoard(board.id, (current) => ({ ...current, selectedFighter: name }));
  showToast(`${name}を選択しました`);
}

function normalizeFighterSearch(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60))
    .replace(/[\s・.／\/＆&()（）_-]/g, "");
}

function fighterGroup(name) {
  const first = normalizeFighterSearch(name).charAt(0);
  if (/^[あいうえおゔw]/.test(first)) return "あ";
  if (/^[かきくけこがぎぐげご]/.test(first)) return "か";
  if (/^[さしすせそざじずぜぞ]/.test(first)) return "さ";
  if (/^[たちつてとだぢづでど]/.test(first)) return "た";
  if (/^[なにぬねの]/.test(first)) return "な";
  if (/^[はひふへほばびぶべぼぱぴぷぺぽ]/.test(first)) return "は";
  if (/^[まみむめもm]/.test(first)) return "ま";
  if (/^[やゆよ]/.test(first)) return "や";
  if (/^[らりるれろ]/.test(first)) return "ら";
  return "わ";
}

function recentFighters(board) {
  const seen = new Set();
  return [...(Array.isArray(board.history) ? board.history : [])]
    .reverse()
    .map((event) => event.fighter)
    .filter((fighter) => SMASH_FIGHTERS.includes(fighter) && !seen.has(fighter) && seen.add(fighter))
    .slice(0, 6);
}

function recordSmashResult(result) {
  const board = activeBoard();
  const counter = board.counters.find((item) => result === "win" ? item.label.includes("勝") : item.label.includes("負"));
  if (!counter) {
    showToast(result === "win" ? "勝ち項目がありません" : "負け項目がありません");
    return;
  }
  changeCounter(counter.id, 1);
}

function fighterRecord(board, fighter) {
  const win = board.counters.find((counter) => counter.label.includes("勝"));
  const loss = board.counters.find((counter) => counter.label.includes("負"));
  const events = Array.isArray(board.history) ? board.history.filter((event) => event.fighter === fighter) : [];
  return {
    wins: win ? events.filter((event) => event.counterId === win.id).length : 0,
    losses: loss ? events.filter((event) => event.counterId === loss.id).length : 0,
  };
}

function smashMatchHistory(board) {
  const resultByCounterId = new Map();
  board.counters.forEach((counter) => {
    if (counter.label.includes("勝")) resultByCounterId.set(counter.id, "win");
    if (counter.label.includes("負")) resultByCounterId.set(counter.id, "loss");
  });

  return [...(Array.isArray(board.history) ? board.history : [])]
    .reverse()
    .filter((event) => SMASH_FIGHTERS.includes(event.fighter) && resultByCounterId.has(event.counterId))
    .map((event) => ({
      fighter: event.fighter,
      result: resultByCounterId.get(event.counterId),
      at: event.at,
    }));
}

function formatMatchTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日時不明";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function matchHistoryHtml(board) {
  const history = smashMatchHistory(board);
  const wins = history.filter((match) => match.result === "win").length;
  const losses = history.length - wins;
  const winRate = history.length ? Math.round((wins / history.length) * 100) : 0;
  const filtered = state.matchHistoryFilter === "all"
    ? history
    : history.filter((match) => match.result === state.matchHistoryFilter);
  const visible = filtered.slice(0, state.matchHistoryLimit);

  return `
    <section class="match-history ${state.matchHistoryOpen ? "is-open" : ""}" aria-label="対戦履歴">
      <button class="match-history-head" data-action="toggle-match-history-open" aria-expanded="${state.matchHistoryOpen ? "true" : "false"}" aria-label="対戦履歴を${state.matchHistoryOpen ? "閉じる" : "開く"}">
        <div>
          <div class="match-history-title">対戦履歴</div>
          <div class="match-history-summary">全${history.length}戦 ${wins}勝 ${losses}敗${history.length ? `・勝率${winRate}%` : ""}</div>
        </div>
        <span class="match-history-open-control" aria-hidden="true">
          <span class="match-history-open-label">${state.matchHistoryOpen ? "閉じる" : "履歴を見る"}</span>
          <span class="match-history-chevron">⌄</span>
        </span>
      </button>
      ${state.matchHistoryOpen ? `
        <div class="match-history-filters" aria-label="履歴を絞り込み">
          ${[["all", "すべて"], ["win", "勝ち"], ["loss", "負け"]].map(([value, label]) => `<button class="match-history-filter ${state.matchHistoryFilter === value ? "is-active" : ""}" data-action="filter-match-history" data-filter="${value}" aria-label="履歴：${label}">${label}</button>`).join("")}
        </div>
      ${visible.length ? `
        <div class="match-history-list">
          ${visible.map((match) => `
            <div class="match-history-row">
              <span class="match-result ${match.result}">${match.result === "win" ? "WIN" : "LOSS"}</span>
              <span class="match-opponent">${escapeHtml(match.fighter)}</span>
              <time class="match-time">${escapeHtml(formatMatchTime(match.at))}</time>
            </div>
          `).join("")}
        </div>
      ` : `<div class="match-history-empty">${history.length ? "条件に合う履歴がありません" : "勝敗を記録すると、ここに対戦履歴が並びます"}</div>`}
      ${filtered.length > 10 ? `
        <button class="match-history-more" data-action="toggle-match-history">${state.matchHistoryLimit < filtered.length ? `さらに表示（残り${filtered.length - visible.length}件）` : "10件表示に戻す"}</button>
      ` : ""}
      ` : ""}
    </section>
  `;
}

function addCounter() {
  const input = document.querySelector("[data-input='new-counter']");
  const label = (input?.value || "").trim();
  if (!label) return;

  const board = activeBoard();
  updateBoard(board.id, (current) => ({
    ...current,
    counters: [...current.counters, makeCounter(label, 0, "", true)],
  }));
  showToast("項目を追加しました");
}

function deleteCounter(counterId) {
  const board = activeBoard();
  const target = board.counters.find((counter) => counter.id === counterId);
  if (!target) return;

  const ok = window.confirm(`「${target.label}」を削除しますか？

この項目のカウント数も削除されます。`);
  if (!ok) return;

  updateBoard(board.id, (current) => {
    const nextCounters = current.counters.filter((counter) => counter.id !== counterId);
    const nextHistory = Array.isArray(current.history) ? current.history.filter((event) => event.counterId !== counterId) : [];
    return { ...current, counters: nextCounters.length ? nextCounters : [makeCounter("カウント")], history: nextHistory };
  });
  showToast("項目を削除しました");
}

function toggleIncludeInTotal(counterId) {
  const board = activeBoard();
  updateBoard(board.id, (current) => ({
    ...current,
    counters: current.counters.map((counter) => (
      counter.id === counterId ? { ...counter, includeInTotal: counter.includeInTotal === false } : counter
    )),
  }));
}

function applyTotalPreset(type) {
  const board = activeBoard();
  updateBoard(board.id, (current) => ({
    ...current,
    counters: current.counters.map((counter) => {
      if (type === "all") return { ...counter, includeInTotal: true };
      if (type === "none") return { ...counter, includeInTotal: false };
      return counter;
    }),
  }));

  if (type === "all") showToast("すべて合計対象にしました");
  if (type === "none") showToast("合計対象を外しました");
}

function startEdit(counterId, label) {
  state.editingCounterId = counterId;
  state.draftLabel = label;
  render();
  requestAnimationFrame(() => {
    const input = document.querySelector("[data-input='edit-counter']");
    if (input) {
      input.focus();
      input.select();
    }
  });
}

function finishEdit() {
  const board = activeBoard();
  const input = document.querySelector("[data-input='edit-counter']");
  const label = (input?.value || state.draftLabel || "").trim();
  const targetId = state.editingCounterId;

  state.editingCounterId = null;
  state.draftLabel = "";

  if (!targetId || !label) {
    render();
    return;
  }

  updateBoard(board.id, (current) => ({
    ...current,
    counters: current.counters.map((counter) => counter.id === targetId ? { ...counter, label } : counter),
  }));
}

function updateMemo(value) {
  const board = activeBoard();
  board.memo = value;
  saveData();
  queueDraftSave();
}

function resetBoard() {
  const board = activeBoard();
  const ok = window.confirm(`${board.name} のカウントをすべて0に戻しますか？`);
  if (!ok) return;

  state.lastAction = null;
  updateBoard(board.id, (current) => ({
    ...current,
    counters: current.counters.map((counter) => ({ ...counter, value: 0 })),
    history: [],
  }));
  showToast("カウントをリセットしました");
}

function clearMemoText() {
  const board = activeBoard();
  if (!board.memo || !board.memo.trim()) {
    showToast("メモは空です");
    return;
  }

  const ok = window.confirm(`「${board.name}」のメモを削除しますか？

カウント数は残ります。`);
  if (!ok) return;

  updateBoard(board.id, (current) => ({ ...current, memo: "" }));
  showToast("メモをリセットしました");
}

function deleteActiveBoard() {
  const board = activeBoard();
  const ok = window.confirm(`「${board.name}」を削除しますか？

このボード内の項目・カウント・メモも削除されます。`);
  if (!ok) return;

  const remainingBoards = state.data.boards.filter((item) => item.id !== board.id);

  if (remainingBoards.length === 0) {
    state.data = createInitialData();
  } else {
    state.data.boards = remainingBoards;
    state.data.activeBoardId = remainingBoards[0].id;
  }

  state.lastAction = null;
  state.editingCounterId = null;
  state.draftLabel = "";
  state.editingBoardName = false;
  state.draftBoardName = "";
  state.targetSettingsOpen = false;
  saveData();
  render();
  showToast("ボードを削除しました");
}

function buildPlainTextExport() {
  const board = activeBoard();
  const targetTotal = calcTargetTotal(board.counters);
  const allTotal = calcAllTotal(board.counters);
  const top = getTopCounter(board.counters);
  const streak = getTargetStreak(board);
  const lines = [];

  lines.push(`【${board.name}】`);
  lines.push(`対象合計 ${targetTotal}`);
  lines.push(`全体 ${allTotal}`);
  lines.push(`連続 ${formatStreak(streak)}`);
  if (top) lines.push(`最多 ${top.label} ${clampCount(top.value)}`);
  lines.push("");
  lines.push("■カウント");
  board.counters.forEach((counter) => {
    const mark = counter.includeInTotal === false ? "対象外" : "対象";
    lines.push(`・${counter.label} ${clampCount(counter.value)}（${mark}）`);
  });

  if (board.mode === "smash") {
    lines.push("");
    lines.push("■ファイター別");
    SMASH_FIGHTERS.forEach((fighter) => {
      const record = fighterRecord(board, fighter);
      if (record.wins + record.losses > 0) lines.push(`・${fighter} ${record.wins}勝${record.losses}敗`);
    });
  }

  if ((board.memo || "").trim()) {
    lines.push("");
    lines.push("■メモ");
    lines.push(board.memo.trim());
  }

  return lines.join("\n");
}

async function copyTextExport() {
  const text = buildPlainTextExport();
  try {
    await navigator.clipboard.writeText(text);
    showToast("テキストをコピーしました");
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    showToast(ok ? "テキストをコピーしました" : "コピーできませんでした");
  }
}

async function importJson(file) {
  if (!file) return;
  const text = await file.text();
  const normalized = normalizeImportedData(safeParse(text));
  fileInput.value = "";
  if (!normalized) {
    showToast("読み込みに失敗しました");
    return;
  }
  state.data = normalized;
  state.lastAction = null;
  state.editingCounterId = null;
  saveData();
  render();
  showToast("JSONを読み込みました");
}

function counterHtml(counter, targetTotal, allTotal) {
  const value = clampCount(counter.value);
  const included = counter.includeInTotal !== false;
  const baseTotal = included ? targetTotal : allTotal;
  const ratio = baseTotal > 0 ? Math.round((value / baseTotal) * 100) : 0;
  const isEditing = state.editingCounterId === counter.id;
  const labelHtml = isEditing
    ? `<input class="edit-input" data-input="edit-counter" value="${escapeHtml(state.draftLabel || counter.label)}" />`
    : `<div class="counter-label">${escapeHtml(counter.label)}</div>`;
  const editButton = isEditing
    ? `<button class="side-btn ok" data-action="finish-edit" aria-label="編集を保存">✓</button>`
    : `<button class="side-btn" data-action="start-edit" data-counter-id="${counter.id}" data-label="${escapeHtml(counter.label)}" aria-label="項目名を編集">✎</button>`;

  return `
    <article class="counter-card">
      <div class="counter-grid">
        <button class="count-main" data-action="plus" data-counter-id="${counter.id}" aria-label="${escapeHtml(counter.label)}を増やす">
          <div class="counter-head">
            <div class="counter-title-wrap">
              ${labelHtml}
            </div>
            <div class="plus-badge">＋</div>
          </div>
          <div class="count-line">
            <div class="count-value">${value}</div>
            <div class="ratio">${included ? `${ratio}%` : ""}</div>
          </div>
          <div class="bar"><div class="bar-fill ${included ? "" : "off"}" style="width:${included ? ratio : 0}%"></div></div>
        </button>
        <div class="side-actions">
          <button class="side-btn" data-action="minus" data-counter-id="${counter.id}" aria-label="${escapeHtml(counter.label)}を減らす">−</button>
          ${editButton}
          <button class="side-btn danger" data-action="delete-counter" data-counter-id="${counter.id}" aria-label="項目を削除">×</button>
        </div>
      </div>
    </article>
  `;
}

function smashPanelHtml(board) {
  if (board.mode !== "smash") return "";
  const query = normalizeFighterSearch(state.fighterQuery);
  const fighters = SMASH_FIGHTERS.filter((fighter) => {
    if (query) return normalizeFighterSearch(fighter).includes(query);
    return state.fighterGroup === "すべて" || fighterGroup(fighter) === state.fighterGroup;
  });
  const recent = recentFighters(board);
  const currentRecord = board.selectedFighter ? fighterRecord(board, board.selectedFighter) : null;
  return `
    <section class="smash-panel" aria-label="対戦相手ファイター">
      <div class="smash-head">
        <div>
          <div class="smash-title">対戦相手を選択</div>
          <div class="smash-help">選んだファイターに、次の勝ち・負けが記録されます</div>
        </div>
        <div class="smash-current">${board.selectedFighter ? escapeHtml(board.selectedFighter) : "未選択"}</div>
      </div>
      ${state.lastMatchFeedback?.boardId === board.id ? `
        <div class="match-feedback" role="status">
          <span class="match-feedback-mark">✓</span>
          <span>${escapeHtml(state.lastMatchFeedback.fighter)}戦の${escapeHtml(state.lastMatchFeedback.result)}を記録しました</span>
        </div>
      ` : ""}
      ${board.selectedFighter ? `
        <div class="smash-command">
          <div class="smash-command-name">vs ${escapeHtml(board.selectedFighter)}</div>
          <div class="smash-command-record">この相手との戦績 ${currentRecord.wins}勝 ${currentRecord.losses}敗</div>
          <div class="smash-quick-actions">
            <button class="smash-result-btn win" data-action="quick-win">勝ち ＋1</button>
            <button class="smash-result-btn loss" data-action="quick-loss">負け ＋1</button>
          </div>
        </div>
      ` : ""}
      ${matchHistoryHtml(board)}
      <div class="fighter-search-wrap">
        <input class="text-input fighter-search" data-input="fighter-search" value="${escapeHtml(state.fighterQuery)}" placeholder="名前を検索（ひらがなでもOK）" inputmode="search" autocomplete="off" />
        ${state.fighterQuery ? `<button class="fighter-search-clear" data-action="clear-fighter-search" aria-label="検索をクリア">×</button>` : ""}
      </div>
      <div class="fighter-groups" aria-label="50音で絞り込み">
        ${FIGHTER_GROUPS.map((group) => `<button class="fighter-group-btn ${!query && state.fighterGroup === group ? "is-active" : ""}" data-action="filter-fighter-group" data-group="${group}">${group}</button>`).join("")}
      </div>
      ${recent.length ? `
        <div class="fighter-recent">
          <div class="fighter-section-label">最近使ったファイター</div>
          <div class="fighter-recent-row">
            ${recent.map((fighter) => {
              const record = fighterRecord(board, fighter);
              return `<button class="fighter-recent-btn" data-action="select-fighter" data-fighter="${escapeHtml(fighter)}">${escapeHtml(fighter)}<span class="fighter-record">${record.wins}勝 ${record.losses}敗</span></button>`;
            }).join("")}
          </div>
        </div>
      ` : ""}
      <div class="fighter-grid">
        ${fighters.length ? fighters.map((fighter) => {
          const record = fighterRecord(board, fighter);
          return `<button class="fighter-btn ${board.selectedFighter === fighter ? "is-selected" : ""}" data-action="select-fighter" data-fighter="${escapeHtml(fighter)}">
            ${escapeHtml(fighter)}<span class="fighter-record">${record.wins}勝 ${record.losses}敗</span>
          </button>`;
        }).join("") : `<div class="fighter-empty">該当するファイターがいません</div>`}
      </div>
    </section>
  `;
}

function render() {
  const board = activeBoard();
  const targetTotal = calcTargetTotal(board.counters);
  const allTotal = calcAllTotal(board.counters);
  const targetCount = countTargetCounters(board.counters);
  const topCounter = getTopCounter(board.counters);
  const streak = getTargetStreak(board);

  app.innerHTML = `
    <header class="top">
      <div class="top-row">
        <div class="brand">
          <div class="eyebrow">✦ Pocket Count</div>
          ${state.editingBoardName ? `
            <input class="board-title-input" data-input="board-name" value="${escapeHtml(state.draftBoardName || board.name)}" aria-label="ボード名を編集" />
          ` : `
            <button class="board-title-button" data-action="start-board-edit" aria-label="ボード名を編集">
              <span class="board-title-text">${escapeHtml(board.name)}</span>
              <span class="title-edit-mark">✎</span>
            </button>
          `}
        </div>
        <div class="row">
          <button class="icon-btn" data-action="undo" ${state.lastAction ? "" : "disabled"} aria-label="直前の操作を戻す">↶</button>
          <button class="icon-btn primary" data-action="copy-text" aria-label="テキストをコピー">⧉</button>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-label">対象合計</div><div class="stat-value">${targetTotal}</div></div>
        <div class="stat"><div class="stat-label">全体</div><div class="stat-value">${allTotal}</div></div>
        <div class="stat"><div class="stat-label">連続</div><div class="stat-value small">${escapeHtml(formatStreak(streak))}</div></div>
      </div>
    </header>

    <section class="panel" aria-label="ボードを追加">
      <div class="input-row">
        <input class="text-input" data-input="new-board" placeholder="ボード名を入力" />
        <button class="small-btn" data-action="add-board">追加</button>
      </div>
    </section>

    <section class="boards-wrap" aria-label="ボード一覧">
      <div class="boards">
        ${state.data.boards.map((item) => `
          <button class="board-tab ${item.id === board.id ? "is-active" : ""}" data-action="select-board" data-board-id="${item.id}">
            <span>
              <span class="board-name">${escapeHtml(item.name)}</span>
              <span class="board-sub">対象 ${calcTargetTotal(item.counters)}</span>
            </span>
            <span aria-hidden="true">◉</span>
          </button>
        `).join("")}
      </div>
    </section>

    <section class="panel" aria-label="プリセットからボードを追加">
      <div class="preset-row" aria-label="プリセット">
        ${PRESETS.map((preset) => `
          <button class="preset-btn" data-action="add-preset" data-preset-key="${preset.key}">＋ ${escapeHtml(preset.name)}</button>
        `).join("")}
      </div>
    </section>

    <section class="target-strip ${state.targetSettingsOpen ? "is-open" : ""}">
      <button class="target-summary" data-action="toggle-target-panel" aria-expanded="${state.targetSettingsOpen ? "true" : "false"}">
        <span class="target-summary-main">
          <span class="target-summary-label">対象合計</span>
          <span class="target-summary-value">${targetTotal}</span>
          <span class="target-summary-sub">${targetCount}/${board.counters.length}項目を集計中</span>
        </span>
        <span class="target-edit-pill">${state.targetSettingsOpen ? "閉じる" : "対象を変更"}</span>
      </button>
      <div class="target-detail">
        <div class="target-help">対象合計に入れる項目を選択。カウント中は閉じて、カード操作に集中できます。</div>
        <div class="target-actions" aria-label="合計対象の一括操作">
          <button class="target-btn dark" data-action="target-all">すべて対象</button>
          <button class="target-btn gray" data-action="target-none">すべて外す</button>
        </div>
        <div class="target-picker" aria-label="合計対象を選択">
          ${board.counters.map((counter) => {
            const included = counter.includeInTotal !== false;
            return `
              <button class="target-chip ${included ? "on" : ""}" data-action="toggle-include" data-counter-id="${counter.id}" aria-label="${escapeHtml(counter.label)}を合計対象にするか切り替え">
                <span class="chip-mark">${included ? "✓" : "−"}</span>
                <span class="chip-label">${escapeHtml(counter.label)}</span>
              </button>
            `;
          }).join("")}
        </div>
      </div>
    </section>

    <main class="counter-list">
      ${board.counters.map((counter) => counterHtml(counter, targetTotal, allTotal)).join("")}
    </main>

    ${smashPanelHtml(board)}

    <section class="panel">
      <div class="input-row">
        <input class="text-input" data-input="new-counter" placeholder="項目名を入力" />
        <button class="small-btn blue" data-action="add-counter">追加</button>
      </div>
    </section>

    <section class="panel">
      <div class="memo-title">▣ メモ</div>
      <textarea class="memo" data-input="memo" placeholder="気づき、今日のテーマ、次回やること。未入力ならこの薄い文字だけが見えます。">${escapeHtml(board.memo || "")}</textarea>
      <div class="memo-actions">
        <button class="memo-clear-btn" data-action="clear-memo">メモをリセット</button>
      </div>
    </section>

    <section class="tools">
      <button class="tool-btn" data-action="copy-text">⧉ テキストコピー</button>
      <button class="tool-btn" data-action="start-board-edit">✎ 名称変更</button>
      <button class="tool-btn" data-action="reset">× リセット</button>
      <button class="tool-btn danger" data-action="delete-board">ボード削除</button>
    </section>
  `;

  requestAnimationFrame(restoreInputDraftOnce);
}

function runSelfTests() {
  const counters = [
    { id: "w", label: "勝ち", value: 3, includeInTotal: true },
    { id: "l", label: "負け", value: 1, includeInTotal: true },
    { id: "m", label: "ミス", value: 2, includeInTotal: false },
  ];

  console.assert(calcAllTotal(counters) === 6, "calcAllTotal should sum all values");
  console.assert(calcTargetTotal(counters) === 4, "calcTargetTotal should sum included values");
  console.assert(calcTargetTotal([{ id: "x", label: "自由項目", value: 5, includeInTotal: true }, { id: "y", label: "観察メモ", value: 9, includeInTotal: false }]) === 5, "target total should support arbitrary selected counters");
  console.assert(countTargetCounters(counters) === 2, "countTargetCounters should count included counters");
  console.assert(PRESETS.find((preset) => preset.key === "smash").counters.length === 2, "smash preset should start with win/loss only");
  console.assert(SMASH_FIGHTERS.length === 89 && new Set(SMASH_FIGHTERS).size === 89, "smash fighter list should contain 89 unique entries");
  console.assert(normalizeFighterSearch(" カービィ ") === normalizeFighterSearch("かーびぃ"), "fighter search should ignore script and whitespace differences");
  console.assert(fighterGroup("Wii Fit トレーナー") === "あ" && fighterGroup("リドリー") === "ら", "fighter groups should follow Japanese reading order");
  console.assert(recentFighters({ history: [{ fighter: "ゼルダ" }, { fighter: "カービィ" }, { fighter: "ゼルダ" }] }).join(",") === "ゼルダ,カービィ", "recent fighters should be unique and newest first");
  console.assert(smashMatchHistory({ counters: [{ id: "w", label: "勝ち" }, { id: "l", label: "負け" }], history: [{ counterId: "w", fighter: "カービィ", at: "2026-01-01" }, { counterId: "l", fighter: "ゼルダ", at: "2026-01-02" }] })[0].fighter === "ゼルダ", "match history should show the newest fight first");
  console.assert(true, "counter labels are allowed to wrap to improve compact two-column readability");
  console.assert(true, "included counters show percentage while excluded counters omit percentage instead of showing a large badge");
  console.assert(PRESETS.find((preset) => preset.key === "sf6").memo === "", "preset memo should be placeholder-only by default");
  console.assert(typeof window.confirm === "function", "delete confirmation should be available through window.confirm");
  console.assert(typeof clearMemoText === "function", "memo text reset should be available as a separate action from count reset");
  console.assert(createInitialData().boards.length === 1, "deleting the final board can fall back to a fresh default board");
  console.assert(typeof state?.targetSettingsOpen !== "undefined", "target settings should support progressive disclosure state");
  console.assert(getTopCounter(counters).label === "勝ち", "getTopCounter should return highest counter");
  const streakBoard = { counters, history: [{ counterId: "m" }, { counterId: "w" }, { counterId: "w" }, { counterId: "m" }, { counterId: "w" }, { counterId: "w" }] };
  console.assert(getTargetStreak(streakBoard).count === 4, "target streak should ignore excluded counters between included events");
  console.assert(formatStreak({ label: "勝ち", count: 3 }) === "3連勝", "win streak should be formatted as 連勝");

  const minus = changeCounterValue([{ id: "a", label: "A", value: 0 }], "a", -1);
  console.assert(minus.counters[0].value === 0, "counter should not go below zero");
  console.assert(minus.actualDiff === 0, "actualDiff should be zero when clamped");

  const plus = changeCounterValue([{ id: "a", label: "A", value: 1 }], "a", 2);
  console.assert(plus.counters[0].value === 3, "counter should increase");
  console.assert(plus.actualDiff === 2, "actualDiff should match diff");

  const normalized = normalizeImportedData({ boards: [{ name: "Test", counters: [{ label: "A", value: -5 }] }] });
  console.assert(normalized.boards[0].counters[0].value === 0, "imported negative values should be clamped");
  console.assert(normalized.boards[0].counters[0].includeInTotal === true, "old imported counters should be included by default");
  console.assert(Array.isArray(normalized.boards[0].history), "imported boards should have history arrays");

  const fallback = normalizeImportedData({ boards: [{ name: "Empty", counters: [] }] });
  console.assert(fallback.boards[0].counters.length === 1, "empty imported board should receive one counter");

  const smashData = normalizeImportedData({ boards: [{ name: "スマブラ", mode: "smash", selectedFighter: "カービィ", counters: [{ id: "w", label: "勝ち", value: 1 }], history: [{ counterId: "w", fighter: "カービィ" }] }] });
  console.assert(smashData.boards[0].mode === "smash" && smashData.boards[0].selectedFighter === "カービィ", "smash board settings should survive normalization");
  console.assert(fighterRecord(smashData.boards[0], "カービィ").wins === 1, "fighter records should be derived from linked history");
}
