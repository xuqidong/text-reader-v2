import {
  deleteBookAndRelated,
  deleteSavedWordRecords,
  getAllRecords,
  getCustomDictionaryRecords,
  getRecord,
  importUserData,
  isPublicDictionarySource,
  legacyHighlightToSavedWord,
  mergeCustomDictionary,
  migrateLegacyHighlights,
  openDatabase,
  putRecord
} from "./db.js";
import {
  CORE_DICTIONARY_COUNT,
  importDictionaryFile,
  installFullDictionary,
  isSingleEnglishWord,
  lookupDictionary,
  normalizeDictionaryTerm,
  getDictionaryInfo,
  prepareCoreDictionary
} from "./dictionary.js";
import {
  clearSyncConfig,
  getLastSync,
  getSyncConfig,
  initializeSync,
  isSyncConfigured,
  pullCloudToDevice,
  pushDeviceToCloud,
  saveSyncConfig,
  signIn,
  signOut,
  signUp
} from "./sync.js";

const APP_VERSION = "v40";
const BACKUP_VERSION = 2;
const RENDER_CHUNK_SIZE = 2000;
const DEFAULT_FONT_SIZE = 20;

const state = {
  books: [],
  savedWords: [],
  positions: new Map(),
  currentBook: null,
  currentBookWords: [],
  renderedChunks: [],
  selectedRange: null,
  lookup: null,
  lookupRequestId: 0,
  currentView: "library",
  fontSize: clampNumber(Number(localStorage.getItem("reader-font-size")) || DEFAULT_FONT_SIZE, 16, 30),
  theme: localStorage.getItem("reader-theme") || "paper",
  scrollSaveTimer: null,
  pendingWrites: Promise.resolve(),
  toastTimer: null,
  syncSession: null,
  syncBusy: false,
  syncNotice: "",
  syncError: "",
  dictionaryInfo: null,
  dictionaryProgress: null,
  dictionaryBusy: false,
  restoringPosition: false,
  lookupReturnFocus: null
};

const els = Object.fromEntries([
  "app", "libraryView", "vocabularyView", "settingsView", "readerView", "appNav",
  "fileInput", "dictionaryInput", "backupInput", "bookCount", "bookList",
  "savedWordCount", "wordSearch", "wordBookFilter", "savedWordList",
  "settingsFontDown", "settingsFontUp", "fontSizeValue", "fontSizeTrack",
  "storageBadge", "storageStatus", "storageMeter", "protectStorage",
  "dictionaryBadge", "dictionaryStatus", "dictionaryProgress", "dictionaryProgressBar",
  "dictionaryProgressText", "repairCoreDictionary", "installFullDictionary",
  "syncBadge", "syncStatus", "syncLastStatus", "syncSignedOut", "syncSignedIn",
  "syncEmail", "syncPassword", "syncSignIn", "syncSignUp", "syncAccount",
  "syncPush", "syncPull", "syncSignOut", "syncSetupDetails", "supabaseUrl",
  "supabaseKey", "saveSupabaseConfig", "clearSupabaseConfig", "exportData",
  "appVersion", "readerBack", "readerTitle", "readerMeta", "readerOptionsButton",
  "readerControls", "readerFontDown", "readerFontUp", "readerFontValue", "reader",
  "lookupSheet", "selectedText", "lookupPhonetic", "lookupResult", "lookupContext",
  "lookupHint", "closeLookup", "saveSelectedWord", "removeSelectedWord",
  "openDictionarySettings", "toast"
].map((id) => [id, document.getElementById(id)]));

init().catch((error) => {
  console.error(error);
  showToast(`启动失败：${error.message || "未知错误"}`, 8000);
  els.bookList.replaceChildren(createEmptyCard("应用没有成功启动", "请刷新页面；如果仍然失败，请关闭其他打开的 Text Reader 页面。"));
});

async function init() {
  applyReadingPreferences();
  bindEvents();
  els.appVersion.textContent = APP_VERSION;
  registerServiceWorker();
  await openDatabase();
  await migrateLegacyHighlights();
  await refreshAppData();
  showView("library", { focus: false });
  updateStorageStatus().catch((error) => console.warn("Storage status unavailable", error));
  refreshDictionaryStatus().catch((error) => console.warn("Dictionary status unavailable", error));
  initializeSync(handleAuthChange).catch((error) => {
    state.syncError = `暂时无法连接同步服务：${error.message}`;
    renderSyncStatus();
  });
  refreshLastSyncStatus();

  prepareCoreDictionary({ onProgress: handleDictionaryProgress })
    .then(refreshDictionaryStatus)
    .catch((error) => {
      console.error(error);
      state.dictionaryProgress = { phase: "core", status: "failed", error: error.message };
      renderDictionaryStatus();
    });
}

function bindEvents() {
  for (const button of els.appNav.querySelectorAll("[data-view]")) {
    button.addEventListener("click", () => showView(button.dataset.view));
  }

  els.fileInput.addEventListener("change", handleBookImport);
  els.dictionaryInput.addEventListener("change", handleCustomDictionaryImport);
  els.backupInput.addEventListener("change", handleBackupImport);
  els.exportData.addEventListener("click", exportBackup);
  els.wordSearch.addEventListener("input", renderVocabulary);
  els.wordBookFilter.addEventListener("change", renderVocabulary);

  els.settingsFontDown.addEventListener("click", () => adjustFontSize(-1));
  els.settingsFontUp.addEventListener("click", () => adjustFontSize(1));
  els.readerFontDown.addEventListener("click", () => adjustFontSize(-1));
  els.readerFontUp.addEventListener("click", () => adjustFontSize(1));
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.addEventListener("click", () => setTheme(button.dataset.themeChoice));
  }

  els.protectStorage.addEventListener("click", () => requestStorageProtection(false));
  els.repairCoreDictionary.addEventListener("click", repairCoreDictionary);
  els.installFullDictionary.addEventListener("click", handleFullDictionaryInstall);

  els.saveSupabaseConfig.addEventListener("click", configureSync);
  els.clearSupabaseConfig.addEventListener("click", removeSyncConfiguration);
  els.syncSignIn.addEventListener("click", handleSignIn);
  els.syncSignUp.addEventListener("click", handleSignUp);
  els.syncSignOut.addEventListener("click", handleSignOut);
  els.syncPush.addEventListener("click", handlePush);
  els.syncPull.addEventListener("click", handlePull);

  els.readerBack.addEventListener("click", closeReader);
  els.readerOptionsButton.addEventListener("click", toggleReaderControls);
  els.reader.addEventListener("click", handleReaderClick);
  els.reader.addEventListener("mouseup", updateNativeSelection);
  els.reader.addEventListener("touchend", () => window.setTimeout(updateNativeSelection, 100));
  els.reader.addEventListener("keyup", updateNativeSelection);
  els.reader.addEventListener("scroll", handleReaderScroll, { passive: true });
  els.closeLookup.addEventListener("click", closeLookupSheet);
  els.saveSelectedWord.addEventListener("click", saveSelectedWord);
  els.removeSelectedWord.addEventListener("click", removeSelectedWords);
  els.openDictionarySettings.addEventListener("click", openSettingsFromReader);

  document.addEventListener("click", (event) => {
    if (!els.readerControls.hidden
      && !els.readerControls.contains(event.target)
      && !els.readerOptionsButton.contains(event.target)) {
      hideReaderControls();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!els.lookupSheet.hidden) {
      event.preventDefault();
      closeLookupSheet();
    } else if (!els.readerControls.hidden) {
      event.preventDefault();
      hideReaderControls();
      els.readerOptionsButton.focus({ preventScroll: true });
    }
  });
  window.addEventListener("pagehide", () => saveReadingPosition());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveReadingPosition();
  });
}

async function refreshAppData() {
  const [books, savedWords, positions] = await Promise.all([
    getAllRecords("books"),
    getAllRecords("savedWords"),
    getAllRecords("positions")
  ]);
  state.books = books.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  state.savedWords = savedWords.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  state.positions = new Map(positions.map((item) => [item.bookId, item]));

  if (state.currentBook) {
    state.currentBook = state.books.find((book) => book.id === state.currentBook.id) || null;
    state.currentBookWords = state.currentBook
      ? state.savedWords.filter((item) => item.bookId === state.currentBook.id).sort((a, b) => a.start - b.start)
      : [];
  }

  renderLibrary();
  renderBookFilter();
  renderVocabulary();
}

function showView(viewName, { focus = true } = {}) {
  const views = {
    library: els.libraryView,
    vocabulary: els.vocabularyView,
    settings: els.settingsView
  };
  if (!views[viewName]) return;

  state.currentView = viewName;
  els.app.classList.remove("reader-open");
  els.readerView.hidden = true;
  for (const [name, element] of Object.entries(views)) element.hidden = name !== viewName;
  for (const button of els.appNav.querySelectorAll("[data-view]")) {
    if (button.dataset.view === viewName) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }

  if (viewName === "library") renderLibrary();
  if (viewName === "vocabulary") renderVocabulary();
  if (viewName === "settings") {
    renderReadingSettings();
    updateStorageStatus();
    refreshDictionaryStatus();
    renderSyncStatus();
    refreshLastSyncStatus();
  }
  if (focus) views[viewName].querySelector("h1")?.focus?.({ preventScroll: true });
}

function renderLibrary() {
  els.bookCount.textContent = formatCount(state.books.length);
  if (state.books.length === 0) {
    els.bookList.replaceChildren(createEmptyCard("书架还是空的", "导入一本中英文 TXT，点英文单词就能离线查词。"));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const book of state.books) fragment.append(createBookCard(book));
  els.bookList.replaceChildren(fragment);
}

function createBookCard(book) {
  const item = document.createElement("li");
  item.className = "book-card";
  const position = state.positions.get(book.id);
  const progress = getPositionProgress(position);
  const wordCount = state.savedWords.filter((word) => word.bookId === book.id).length;

  const open = document.createElement("button");
  open.type = "button";
  open.className = "book-card__open";
  open.addEventListener("click", () => openBook(book.id));

  const title = document.createElement("strong");
  title.className = "book-card__title";
  title.textContent = book.title;

  const meta = document.createElement("div");
  meta.className = "book-card__meta";
  const progressText = document.createElement("span");
  progressText.textContent = progress == null
    ? (position?.scrollTop > 0 ? "继续阅读" : "未开始")
    : `已读 ${Math.round(progress * 100)}%`;
  const wordsText = document.createElement("span");
  wordsText.textContent = `${formatCount(wordCount)} 个生词`;
  meta.append(progressText, wordsText);

  const track = document.createElement("div");
  track.className = "book-progress";
  const fill = document.createElement("span");
  fill.style.width = `${Math.round((progress || 0) * 100)}%`;
  track.append(fill);
  open.append(title, meta, track);

  const menu = document.createElement("details");
  menu.className = "book-menu";
  const summary = document.createElement("summary");
  summary.setAttribute("aria-label", `${book.title}的更多操作`);
  summary.textContent = "•••";
  const panel = document.createElement("div");
  panel.className = "book-menu__panel";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "删除这本书";
  remove.addEventListener("click", (event) => {
    event.preventDefault();
    removeBook(book.id);
  });
  panel.append(remove);
  menu.append(summary, panel);
  item.append(open, menu);
  return item;
}

async function removeBook(bookId) {
  const book = state.books.find((item) => item.id === bookId);
  if (!book) return;
  if (!window.confirm(`删除《${book.title}》以及这本书的全部生词和阅读进度？`)) return;

  await flushWrites();
  await deleteBookAndRelated(bookId);
  await refreshAppData();
  showToast("书籍已从本机删除。");
}

function renderBookFilter() {
  const current = els.wordBookFilter.value;
  const options = [new Option("全部书籍", "")];
  for (const book of state.books) options.push(new Option(book.title, book.id));
  els.wordBookFilter.replaceChildren(...options);
  if (state.books.some((book) => book.id === current)) els.wordBookFilter.value = current;
}

function renderVocabulary() {
  const query = els.wordSearch.value.trim().toLowerCase();
  const bookId = els.wordBookFilter.value;
  const bookById = new Map(state.books.map((book) => [book.id, book]));
  const groups = groupSavedWords(state.savedWords);
  els.savedWordCount.textContent = formatCount(groups.length);

  const filtered = groups.filter((group) => {
    if (bookId && !group.records.some((item) => item.bookId === bookId)) return false;
    if (!query) return true;
    const haystack = [
      group.term,
      ...group.records.flatMap((item) => [item.surfaceText, item.context, ...(item.definitions || []), bookById.get(item.bookId)?.title || ""])
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  if (filtered.length === 0) {
    const message = state.savedWords.length === 0
      ? createEmptyCard("还没有生词", "阅读时点一个英文单词，再点“保存单词”。")
      : createEmptyCard("没有匹配结果", "换一个关键词或书籍筛选试试。 ");
    els.savedWordList.replaceChildren(message);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const group of filtered) fragment.append(createWordCard(group, bookById, bookId));
  els.savedWordList.replaceChildren(fragment);
}

function groupSavedWords(words) {
  const groups = new Map();
  for (const word of words) {
    const key = word.kind === "word" && word.normalizedTerm
      ? `word:${word.normalizedTerm}`
      : `legacy:${word.id}`;
    if (!groups.has(key)) groups.set(key, { key, term: word.term || word.surfaceText, records: [] });
    groups.get(key).records.push(word);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, records: group.records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) }))
    .sort((a, b) => String(b.records[0]?.createdAt).localeCompare(String(a.records[0]?.createdAt)));
}

function createWordCard(group, bookById, preferredBookId = "") {
  const preferredRecords = preferredBookId
    ? group.records.filter((item) => item.bookId === preferredBookId)
    : group.records;
  const record = preferredRecords.find((item) => item.definitions?.length)
    || preferredRecords[0]
    || group.records.find((item) => item.definitions?.length)
    || group.records[0];
  const item = document.createElement("li");
  item.className = "word-card";

  const body = document.createElement("div");
  const termLine = document.createElement("div");
  termLine.className = "word-card__term";
  const term = document.createElement("strong");
  term.lang = "en";
  term.textContent = group.term || record.surfaceText;
  const phonetic = document.createElement("span");
  phonetic.className = "phonetic";
  phonetic.lang = "en";
  phonetic.textContent = record.phonetic ? `/${record.phonetic}/` : "";
  termLine.append(term, phonetic);

  const definition = document.createElement("p");
  definition.className = "word-card__definition";
  definition.textContent = record.definitions?.length ? record.definitions.slice(0, 3).join("；") : "尚未保存释义";
  const context = document.createElement("p");
  context.className = "word-card__context";
  context.lang = "en";
  context.textContent = record.context || record.surfaceText || "";
  const source = document.createElement("p");
  source.className = "word-card__source";
  const bookNames = [...new Set(group.records.map((item) => bookById.get(item.bookId)?.title).filter(Boolean))];
  source.textContent = `${bookNames.join("、") || "已删除的书籍"}${group.records.length > 1 ? ` · ${group.records.length} 处` : ""}`;
  body.append(termLine, definition, context, source);

  const actions = document.createElement("div");
  actions.className = "word-card__actions";
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "button button--secondary";
  jump.textContent = "回到原文";
  jump.disabled = !bookById.has(record.bookId);
  jump.addEventListener("click", () => jumpToSavedWord(record));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "text-button text-button--danger";
  remove.textContent = group.records.length > 1 ? `全部取消（${group.records.length}）` : "取消保存";
  remove.addEventListener("click", () => removeWordGroup(group));
  actions.append(jump, remove);
  item.append(body, actions);
  return item;
}

async function removeWordGroup(group) {
  if (group.records.length > 1 && !window.confirm(`取消“${group.term}”的全部 ${group.records.length} 处保存？`)) return;
  await deleteSavedWordRecords(group.records.map((item) => item.id));
  const ids = new Set(group.records.map((item) => item.id));
  state.savedWords = state.savedWords.filter((item) => !ids.has(item.id));
  renderVocabulary();
  renderLibrary();
  showToast("已取消保存。 ");
}

async function handleBookImport(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  try {
    showToast(`正在导入 ${file.name}…`, 8000);
    requestStorageProtection(true);
    const text = normalizeBookText(await decodeTextFile(file));
    if (!text) throw new Error("TXT 文件没有可阅读的内容。");
    const id = await hashText(text);
    const existing = state.books.find((book) => book.id === id) || await getRecord("books", id);
    const now = new Date().toISOString();
    const book = {
      id,
      title: file.name.replace(/\.txt$/i, "") || "未命名书籍",
      fileName: file.name,
      text,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      syncStatus: "local"
    };
    await putRecord("books", book);
    await refreshAppData();
    await openBook(id);
    showToast(existing ? "已打开这本书。" : "书籍已导入并保存在本机。 ");
  } catch (error) {
    console.error(error);
    showToast(`导入失败：${error.message}`, 7000);
  }
}

async function decodeTextFile(file) {
  const buffer = await file.arrayBuffer();
  for (const encoding of ["utf-8", "gb18030", "gbk", "big5"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch {
      // Try the next common TXT encoding.
    }
  }
  return new TextDecoder("utf-8").decode(buffer);
}

function normalizeBookText(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

async function hashText(text) {
  if (!crypto.subtle) throw new Error("当前浏览器不支持安全的书籍标识计算。");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function openBook(bookId, targetWord = null) {
  const book = state.books.find((item) => item.id === bookId) || await getRecord("books", bookId);
  if (!book) return;
  await flushWrites();

  state.currentBook = book;
  state.currentBookWords = state.savedWords.filter((item) => item.bookId === bookId).sort((a, b) => a.start - b.start);
  state.renderedChunks = [];
  els.libraryView.hidden = true;
  els.vocabularyView.hidden = true;
  els.settingsView.hidden = true;
  els.readerView.hidden = false;
  els.app.classList.add("reader-open");
  els.readerTitle.textContent = book.title;
  els.reader.lang = detectBookLanguage(book.text);
  renderReader();
  closeLookupSheet();
  hideReaderControls();

  const position = state.positions.get(bookId);
  state.restoringPosition = true;
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (targetWord) focusSavedWord(targetWord);
    else restoreReadingPosition(position);
    state.restoringPosition = false;
    updateReaderProgress();
  }));
}

async function closeReader() {
  await saveReadingPosition();
  closeLookupSheet();
  hideReaderControls();
  state.currentBook = null;
  state.currentBookWords = [];
  state.renderedChunks = [];
  els.reader.replaceChildren();
  showView("library", { focus: false });
}

function renderReader() {
  if (!state.currentBook) {
    els.reader.replaceChildren();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const chunk of getReaderChunks(state.currentBook.text)) {
    const element = document.createElement("span");
    element.dataset.start = String(chunk.start);
    element.dataset.end = String(chunk.end);
    renderChunkContent(element, chunk.text, chunk.start);
    state.renderedChunks.push({ element, start: chunk.start, end: chunk.end });
    fragment.append(element);
  }
  els.reader.replaceChildren(fragment);
}

function getReaderChunks(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + RENDER_CHUNK_SIZE);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start) end = newline + 1;
    }
    chunks.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}

function renderChunkContent(element, text, start) {
  const end = start + text.length;
  const highlights = state.currentBookWords
    .filter((word) => rangesOverlap(word.start, word.end, start, end))
    .sort((a, b) => a.start - b.start);
  const children = [];
  let cursor = 0;

  for (const word of highlights) {
    const localStart = Math.max(0, word.start - start, cursor);
    const localEnd = Math.min(text.length, word.end - start);
    if (localEnd <= localStart) continue;
    if (localStart > cursor) children.push(document.createTextNode(text.slice(cursor, localStart)));
    const mark = document.createElement("mark");
    mark.dataset.savedWordId = word.id;
    mark.dataset.highlightStart = String(start + localStart);
    mark.dataset.highlightEnd = String(start + localEnd);
    mark.textContent = text.slice(localStart, localEnd);
    children.push(mark);
    cursor = localEnd;
  }
  if (cursor < text.length) children.push(document.createTextNode(text.slice(cursor)));
  element.replaceChildren(...children);
}

async function handleReaderClick(event) {
  if (!state.currentBook) return;
  const selected = getActiveReaderSelectionRange();
  if (selected) {
    await showLookup(selected);
    return;
  }
  const nativeSelection = window.getSelection();
  if (nativeSelection && !nativeSelection.isCollapsed) return;

  const range = getClickRange(event);
  if (!range) {
    closeLookupSheet();
    return;
  }
  const offset = getReaderOffset(range.startContainer, range.startOffset);
  const wordRange = offset == null ? null : getWordRangeAtOffset(state.currentBook.text, offset);
  if (wordRange) await showLookup(wordRange);
  else closeLookupSheet();
}

function getClickRange(event) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(event.clientX, event.clientY);
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (!position) return null;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

function getWordRangeAtOffset(text, offset) {
  const isWordCharacter = (char) => /[A-Za-z'’\-]/.test(char || "");
  let start = Math.max(0, Math.min(offset, text.length));
  let end = start;
  while (start > 0 && isWordCharacter(text[start - 1])) start -= 1;
  while (end < text.length && isWordCharacter(text[end])) end += 1;
  const selected = text.slice(start, end).replace(/^['’\-]+|['’\-]+$/g, "");
  const leading = text.slice(start, end).indexOf(selected);
  if (!selected || !/[A-Za-z]/.test(selected)) return null;
  start += Math.max(0, leading);
  return { start, end: start + selected.length, text: selected };
}

async function updateNativeSelection() {
  const range = getActiveReaderSelectionRange();
  if (range) await showLookup(range);
}

function getActiveReaderSelectionRange() {
  if (!state.currentBook) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!els.reader.contains(range.commonAncestorContainer)) return null;
  let start = getReaderOffset(range.startContainer, range.startOffset);
  let end = getReaderOffset(range.endContainer, range.endOffset);
  if (start == null || end == null || start === end) return null;
  if (start > end) [start, end] = [end, start];
  while (start < end && /\s/.test(state.currentBook.text[start])) start += 1;
  while (end > start && /\s/.test(state.currentBook.text[end - 1])) end -= 1;
  const text = state.currentBook.text.slice(start, end);
  return text ? { start, end, text } : null;
}

function getReaderOffset(node, offset) {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const segment = element?.closest?.("[data-start]");
  if (!segment || !els.reader.contains(segment)) return null;
  const range = document.createRange();
  try {
    range.selectNodeContents(segment);
    range.setEnd(node, offset);
    return Number(segment.dataset.start) + range.toString().length;
  } catch {
    return null;
  }
}

async function showLookup(range) {
  const requestId = ++state.lookupRequestId;
  const wasHidden = els.lookupSheet.hidden;
  if (wasHidden) state.lookupReturnFocus = document.activeElement;
  state.selectedRange = range;
  state.lookup = null;
  els.selectedText.textContent = range.text;
  els.lookupPhonetic.textContent = "";
  els.lookupContext.textContent = getSentenceContext(state.currentBook.text, range.start, range.end);
  els.lookupResult.replaceChildren(createDefinitionMessage("正在查询离线词典…"));
  els.lookupHint.textContent = isSingleEnglishWord(range.text) ? "" : "短语可以查询，但当前只保存单个英文词。";
  els.openDictionarySettings.hidden = true;
  els.lookupSheet.hidden = false;
  syncLookupActions();
  if (wasHidden) {
    window.requestAnimationFrame(() => els.closeLookup.focus({ preventScroll: true }));
  }

  try {
    const result = await lookupDictionary(range.text);
    if (requestId !== state.lookupRequestId) return;
    state.lookup = result;
    renderLookupResult();
  } catch (error) {
    if (requestId !== state.lookupRequestId) return;
    state.lookup = { status: "error", message: error.message };
    renderLookupResult();
  }
}

function renderLookupResult() {
  const result = state.lookup;
  els.lookupResult.replaceChildren();
  els.lookupPhonetic.textContent = "";
  els.openDictionarySettings.hidden = true;

  if (!result) {
    els.lookupResult.append(createDefinitionMessage("正在查询离线词典…"));
  } else if (result.status === "found") {
    els.lookupPhonetic.textContent = result.entry.phonetic ? `/${result.entry.phonetic}/` : "";
    const fragment = document.createDocumentFragment();
    for (const [index, definition] of result.entry.definitions.entries()) {
      const row = document.createElement("div");
      row.className = "definition-item";
      const number = document.createElement("span");
      number.textContent = String(index + 1);
      const text = document.createElement("span");
      text.textContent = definition;
      row.append(number, text);
      fragment.append(row);
    }
    if (!result.entry.definitions.length) fragment.append(createDefinitionMessage("这个词条没有中文释义。"));
    els.lookupResult.append(fragment);
    if (result.matchedTerm !== normalizeDictionaryTerm(result.input)) {
      els.lookupHint.textContent = `按词形 ${result.entry.term} 查询。`;
    }
  } else {
    els.lookupResult.append(createDefinitionMessage(result.message || "离线词典中没有找到这个词。"));
    if (result.status === "missing" || result.status === "error") els.openDictionarySettings.hidden = false;
  }
  syncLookupActions();
}

function createDefinitionMessage(message) {
  const element = document.createElement("div");
  element.textContent = message;
  return element;
}

function syncLookupActions() {
  const overlaps = state.selectedRange ? savedWordsOverlapping(state.selectedRange) : [];
  const alreadySaved = overlaps.length > 0;
  const savable = Boolean(state.selectedRange && isSingleEnglishWord(state.selectedRange.text));
  els.saveSelectedWord.hidden = alreadySaved;
  els.saveSelectedWord.disabled = !savable;
  els.removeSelectedWord.hidden = !alreadySaved;
  els.removeSelectedWord.textContent = overlaps.length > 1 ? `取消保存（${overlaps.length}）` : "取消保存";
}

function savedWordsOverlapping(range) {
  return state.currentBookWords.filter((word) => rangesOverlap(word.start, word.end, range.start, range.end));
}

function closeLookupSheet() {
  const returnFocus = state.lookupReturnFocus;
  const shouldRestoreFocus = els.lookupSheet.contains(document.activeElement);
  state.lookupRequestId += 1;
  state.selectedRange = null;
  state.lookup = null;
  state.lookupReturnFocus = null;
  els.lookupSheet.hidden = true;
  window.getSelection()?.removeAllRanges();
  if (shouldRestoreFocus && returnFocus?.isConnected) {
    window.requestAnimationFrame(() => returnFocus.focus?.({ preventScroll: true }));
  }
}

async function saveSelectedWord() {
  if (!state.currentBook || !state.selectedRange || !isSingleEnglishWord(state.selectedRange.text)) return;
  if (savedWordsOverlapping(state.selectedRange).length) return;
  const range = state.selectedRange;
  const entry = state.lookup?.status === "found" ? state.lookup.entry : null;
  const now = new Date().toISOString();
  const savedWord = {
    id: createLocalId("word"),
    kind: "word",
    bookId: state.currentBook.id,
    start: range.start,
    end: range.end,
    surfaceText: range.text,
    term: entry?.term || range.text,
    normalizedTerm: entry?.normalizedTerm || normalizeDictionaryTerm(range.text),
    phonetic: entry?.phonetic || "",
    definitions: entry?.definitions || [],
    context: getSentenceContext(state.currentBook.text, range.start, range.end),
    color: "yellow",
    createdAt: now,
    updatedAt: now,
    syncStatus: "local"
  };

  state.savedWords.unshift(savedWord);
  state.currentBookWords.push(savedWord);
  state.currentBookWords.sort((a, b) => a.start - b.start);
  applyHighlightsInRange(range);
  syncLookupActions();
  showToast("已保存到生词本。 ");

  enqueueWrite(
    () => putRecord("savedWords", savedWord),
    () => {
      state.savedWords = state.savedWords.filter((item) => item.id !== savedWord.id);
      state.currentBookWords = state.currentBookWords.filter((item) => item.id !== savedWord.id);
      applyHighlightsInRange(range);
      syncLookupActions();
    }
  );
}

function removeSelectedWords() {
  if (!state.currentBook || !state.selectedRange) return;
  const removed = savedWordsOverlapping(state.selectedRange);
  if (!removed.length) return;
  const ids = new Set(removed.map((item) => item.id));
  const affected = removed.reduce((range, item) => ({
    start: Math.min(range.start, item.start),
    end: Math.max(range.end, item.end)
  }), { start: state.selectedRange.start, end: state.selectedRange.end });
  state.savedWords = state.savedWords.filter((item) => !ids.has(item.id));
  state.currentBookWords = state.currentBookWords.filter((item) => !ids.has(item.id));
  applyHighlightsInRange(affected);
  syncLookupActions();
  showToast("已取消保存。 ");

  enqueueWrite(
    () => deleteSavedWordRecords([...ids]),
    () => {
      state.savedWords.unshift(...removed);
      state.currentBookWords.push(...removed);
      state.currentBookWords.sort((a, b) => a.start - b.start);
      applyHighlightsInRange(affected);
      syncLookupActions();
    }
  );
}

function applyHighlightsInRange(range) {
  if (!state.currentBook || !range) return;
  const startIndex = findFirstChunkEndingAfter(range.start);
  for (let index = startIndex; index < state.renderedChunks.length; index += 1) {
    const chunk = state.renderedChunks[index];
    if (chunk.start >= range.end) break;
    renderChunkContent(chunk.element, state.currentBook.text.slice(chunk.start, chunk.end), chunk.start);
  }
}

function findFirstChunkEndingAfter(offset) {
  let low = 0;
  let high = state.renderedChunks.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (state.renderedChunks[mid].end <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function getSentenceContext(text, start, end) {
  const maxDistance = 180;
  const beforeFloor = Math.max(0, start - maxDistance);
  const afterCeiling = Math.min(text.length, end + maxDistance);
  const before = text.slice(beforeFloor, start);
  const after = text.slice(end, afterCeiling);
  const beforeBoundary = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("。"));
  const afterMatch = after.search(/[\n.!?。！？]/);
  const contextStart = beforeBoundary >= 0 ? beforeFloor + beforeBoundary + 1 : beforeFloor;
  const contextEnd = afterMatch >= 0 ? end + afterMatch + 1 : afterCeiling;
  return text.slice(contextStart, contextEnd).replace(/\s+/g, " ").trim();
}

async function jumpToSavedWord(record) {
  await openBook(record.bookId, record);
}

function focusSavedWord(record) {
  const chunk = state.renderedChunks.find((item) => rangesOverlap(item.start, item.end, record.start, record.end));
  const mark = chunk?.element.querySelector(`[data-saved-word-id="${CSS.escape(record.id)}"]`);
  const target = mark || chunk?.element;
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "auto" });
  target.classList.add("is-focused");
  window.setTimeout(() => target.classList.remove("is-focused"), 1200);
}

function handleReaderScroll() {
  if (!state.currentBook || state.restoringPosition) return;
  if (!els.lookupSheet.hidden) closeLookupSheet();
  window.clearTimeout(state.scrollSaveTimer);
  state.scrollSaveTimer = window.setTimeout(saveReadingPosition, 250);
  updateReaderProgress();
}

function updateReaderProgress() {
  if (!state.currentBook) return;
  const maxScroll = Math.max(0, els.reader.scrollHeight - els.reader.clientHeight);
  const progress = maxScroll > 0 ? els.reader.scrollTop / maxScroll : 0;
  els.readerMeta.textContent = `${Math.round(progress * 100)}%`;
}

function saveReadingPosition() {
  if (!state.currentBook) return Promise.resolve();
  window.clearTimeout(state.scrollSaveTimer);
  const maxScroll = Math.max(0, els.reader.scrollHeight - els.reader.clientHeight);
  const progress = maxScroll > 0 ? Math.min(1, Math.max(0, els.reader.scrollTop / maxScroll)) : 0;
  const position = {
    bookId: state.currentBook.id,
    scrollTop: els.reader.scrollTop,
    progress,
    anchorOffset: getVisibleAnchorOffset(),
    updatedAt: new Date().toISOString(),
    syncStatus: "local"
  };
  state.positions.set(position.bookId, position);
  return enqueueWrite(() => putRecord("positions", position));
}

function getVisibleAnchorOffset() {
  const top = els.reader.scrollTop + 12;
  const chunk = state.renderedChunks.find((item) => item.element.offsetTop + item.element.offsetHeight > top);
  return chunk?.start || 0;
}

function restoreReadingPosition(position) {
  const progress = getPositionProgress(position);
  if (progress != null) {
    const maxScroll = Math.max(0, els.reader.scrollHeight - els.reader.clientHeight);
    els.reader.scrollTop = progress * maxScroll;
  } else {
    els.reader.scrollTop = Number(position?.scrollTop) || 0;
  }
}

function getPositionProgress(position) {
  if (position?.progress == null || position.progress === "") return null;
  const progress = Number(position?.progress);
  return Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : null;
}

function toggleReaderControls() {
  const opening = els.readerControls.hidden;
  els.readerControls.hidden = !opening;
  els.readerOptionsButton.setAttribute("aria-expanded", String(opening));
}

function hideReaderControls() {
  els.readerControls.hidden = true;
  els.readerOptionsButton.setAttribute("aria-expanded", "false");
}

function adjustFontSize(delta) {
  const previousProgress = state.currentBook ? getCurrentReaderProgress() : null;
  state.fontSize = clampNumber(state.fontSize + delta, 16, 30);
  localStorage.setItem("reader-font-size", String(state.fontSize));
  document.documentElement.style.setProperty("--reader-font-size", `${state.fontSize}px`);
  renderReadingSettings();
  if (previousProgress != null) {
    window.requestAnimationFrame(() => {
      const maxScroll = Math.max(0, els.reader.scrollHeight - els.reader.clientHeight);
      els.reader.scrollTop = previousProgress * maxScroll;
    });
  }
}

function getCurrentReaderProgress() {
  const maxScroll = Math.max(0, els.reader.scrollHeight - els.reader.clientHeight);
  return maxScroll > 0 ? els.reader.scrollTop / maxScroll : 0;
}

function setTheme(theme) {
  if (!["paper", "sepia", "night"].includes(theme)) return;
  state.theme = theme;
  localStorage.setItem("reader-theme", theme);
  applyReadingPreferences();
}

function applyReadingPreferences() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.setProperty("--reader-font-size", `${state.fontSize}px`);
  renderReadingSettings();
}

function renderReadingSettings() {
  els.fontSizeValue.textContent = `${state.fontSize} px`;
  els.readerFontValue.textContent = `${state.fontSize} px`;
  els.fontSizeTrack.style.width = `${((state.fontSize - 16) / 14) * 100}%`;
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === state.theme));
  }
}

async function requestStorageProtection(quiet) {
  if (!navigator.storage?.persist) {
    if (!quiet) showToast("当前浏览器不提供持久存储请求。 ");
    return false;
  }
  try {
    const granted = await navigator.storage.persist();
    await updateStorageStatus();
    if (!quiet) showToast(granted ? "本机存储已获得持久保护。" : "浏览器暂未授予持久保护，请把应用加入主屏幕并保持足够空间。");
    return granted;
  } catch (error) {
    if (!quiet) showToast(`无法请求存储保护：${error.message}`);
    return false;
  }
}

async function updateStorageStatus() {
  if (!navigator.storage) {
    els.storageBadge.textContent = "不可检测";
    els.storageBadge.dataset.status = "warn";
    els.storageStatus.textContent = "当前浏览器无法报告存储状态。请定期同步或导出备份。";
    els.protectStorage.hidden = true;
    return;
  }
  const persistedRequest = navigator.storage.persisted
    ? navigator.storage.persisted().catch(() => false)
    : Promise.resolve(false);
  const estimateRequest = navigator.storage.estimate
    ? navigator.storage.estimate().catch(() => ({}))
    : Promise.resolve({});
  const [persisted, estimate] = await Promise.all([persistedRequest, estimateRequest]);
  const usage = Number(estimate.usage) || 0;
  const quota = Number(estimate.quota) || 0;
  const percent = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0;
  els.storageBadge.textContent = persisted ? "已保护" : "可能被清理";
  els.storageBadge.dataset.status = persisted ? "good" : "warn";
  els.storageStatus.textContent = `${persisted ? "浏览器不会因空间压力自动清理本站数据。" : "手机可能在空间不足时清理本地数据，请保持云端或文件备份。"}${quota > 0 ? ` 已使用 ${formatBytes(usage)} / ${formatBytes(quota)}。` : ""}`;
  els.storageMeter.style.width = `${percent}%`;
  els.protectStorage.hidden = persisted;
}

async function refreshDictionaryStatus() {
  state.dictionaryInfo = await getDictionaryInfo();
  renderDictionaryStatus();
}

function handleDictionaryProgress(progress) {
  state.dictionaryProgress = progress;
  renderDictionaryStatus();
}

function renderDictionaryStatus() {
  const info = state.dictionaryInfo;
  const progress = state.dictionaryProgress;
  if (progress && ["downloading", "installing"].includes(progress.status)) {
    const isCore = progress.phase === "core";
    const isCustom = progress.phase === "custom";
    els.dictionaryBadge.textContent = isCore ? "准备常用词典" : isCustom ? "导入词典" : "安装完整词典";
    els.dictionaryBadge.dataset.status = "warn";
    els.dictionaryStatus.textContent = isCore || isCustom
      ? `${isCustom ? "正在导入自定义词典" : "正在安装内置常用词典"}：${formatCount(progress.importedCount || 0)} / ${formatCount(progress.expectedCount || CORE_DICTIONARY_COUNT)} 条。`
      : `正在安装完整词典，已处理 ${formatCount(progress.sourceRows || 0)} 行；离开页面后下次可以继续。`;
    const ratio = (isCore || isCustom) && progress.expectedCount
      ? (progress.importedCount || 0) / progress.expectedCount
      : progress.totalBytes ? (progress.receivedBytes || 0) / progress.totalBytes : 0;
    els.dictionaryProgress.hidden = false;
    els.dictionaryProgressBar.style.width = `${Math.round(ratio * 100)}%`;
    els.dictionaryProgressText.textContent = ratio > 0 ? `${Math.round(ratio * 100)}%` : "进行中";
    setDictionaryButtonsBusy(true);
    return;
  }

  setDictionaryButtonsBusy(false);
  els.dictionaryProgress.hidden = true;
  const core = info?.core;
  const full = info?.full;
  const count = info?.count || 0;
  if (progress?.status === "failed") {
    els.dictionaryBadge.textContent = "需要修复";
    els.dictionaryBadge.dataset.status = "bad";
    els.dictionaryStatus.textContent = `${progress.error || "词典安装没有完成。"} 已有词条仍可查询。`;
  } else if (full?.status === "ready") {
    els.dictionaryBadge.textContent = "完整离线";
    els.dictionaryBadge.dataset.status = "good";
    els.dictionaryStatus.textContent = `完整 ECDICT 已安装，共 ${formatCount(count)} 条；断网也能查询。`;
  } else if (full && ["failed", "installing"].includes(full.status)) {
    els.dictionaryBadge.textContent = "常用词可用";
    els.dictionaryBadge.dataset.status = "warn";
    els.dictionaryStatus.textContent = `常用词典可用；完整词典上次安装到 ${formatCount(full.sourceRows || 0)} 行，点击可继续。`;
  } else if (core?.status === "ready") {
    els.dictionaryBadge.textContent = "离线可用";
    els.dictionaryBadge.dataset.status = "good";
    els.dictionaryStatus.textContent = `内置常用词典已就绪，共 ${formatCount(Math.min(count, CORE_DICTIONARY_COUNT))} 个高频词。可选安装完整词典。`;
  } else {
    els.dictionaryBadge.textContent = "准备中";
    els.dictionaryBadge.dataset.status = "warn";
    els.dictionaryStatus.textContent = "内置常用词典尚未完整安装，点击修复即可重新准备。";
  }
  els.installFullDictionary.textContent = full?.status === "ready" ? "重新验证完整词典" : full ? "继续安装完整词典" : "安装完整词典";
}

function setDictionaryButtonsBusy(busy) {
  state.dictionaryBusy = busy;
  els.repairCoreDictionary.disabled = busy;
  els.installFullDictionary.disabled = busy;
  els.dictionaryInput.disabled = busy;
}

async function repairCoreDictionary() {
  if (state.dictionaryBusy) return;
  requestStorageProtection(true);
  setDictionaryButtonsBusy(true);
  try {
    await prepareCoreDictionary({ force: true, onProgress: handleDictionaryProgress });
    await refreshDictionaryStatus();
    showToast("常用词典已修复。 ");
  } catch (error) {
    showToast(`修复失败：${error.message}`, 7000);
  } finally {
    setDictionaryButtonsBusy(false);
  }
}

async function handleFullDictionaryInstall() {
  if (state.dictionaryBusy) return;
  const fullReady = state.dictionaryInfo?.full?.status === "ready";
  if (fullReady && !window.confirm("重新验证会再次读取完整词典文件，但不会先删除现有词条。继续吗？")) return;
  requestStorageProtection(true);
  setDictionaryButtonsBusy(true);
  try {
    await installFullDictionary({ restart: fullReady, onProgress: handleDictionaryProgress });
    await refreshDictionaryStatus();
    updateStorageStatus();
    showToast("完整离线词典安装完成。 ");
  } catch (error) {
    console.error(error);
    await refreshDictionaryStatus().catch(() => undefined);
    showToast(`完整词典未安装完：${error.message}，下次可以继续。`, 8000);
  } finally {
    setDictionaryButtonsBusy(false);
  }
}

async function handleCustomDictionaryImport(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (state.dictionaryBusy) {
    showToast("另一个词典任务正在进行，请完成后再导入。 ");
    return;
  }
  setDictionaryButtonsBusy(true);
  try {
    requestStorageProtection(true);
    const count = await importDictionaryFile(file, ({ importedCount, expectedCount }) => {
      handleDictionaryProgress({ phase: "custom", status: "installing", importedCount, expectedCount });
    });
    state.dictionaryProgress = null;
    await refreshDictionaryStatus();
    showToast(`已导入 ${formatCount(count)} 条词典记录。`);
  } catch (error) {
    state.dictionaryProgress = null;
    renderDictionaryStatus();
    showToast(`词典导入失败：${error.message}`, 7000);
  } finally {
    setDictionaryButtonsBusy(false);
  }
}

async function exportBackup() {
  try {
    await flushWrites();
    const [books, savedWords, positions, customDictionary] = await Promise.all([
      getAllRecords("books"),
      getAllRecords("savedWords"),
      getAllRecords("positions"),
      getCustomDictionaryRecords()
    ]);
    const backup = {
      app: "text-reader",
      backupVersion: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      data: { books, savedWords, positions, customDictionary }
    };
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `text-reader-${formatDateForFileName(new Date())}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    // Safari can start consuming a large Blob after click() returns.
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    showToast("备份已导出。 ");
  } catch (error) {
    showToast(`备份失败：${error.message}`, 7000);
  }
}

async function handleBackupImport(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const data = parseBackup(parsed);
    const customDictionarySummary = Array.isArray(data.customDictionary)
      ? `，并合并 ${data.customDictionary.length} 条自定义词典记录`
      : "";
    if (!window.confirm(`用备份覆盖本机的 ${data.books.length} 本书、${data.savedWords.length} 条生词和阅读进度${customDictionarySummary}？公共离线词典和本机其他自定义词条不会被删除。`)) return;
    await flushWrites();
    await importUserData(data, true);
    if (Array.isArray(data.customDictionary)) await mergeCustomDictionary(data.customDictionary);
    await refreshAppData();
    showView("library", { focus: false });
    showToast("备份已恢复。 ");
  } catch (error) {
    console.error(error);
    showToast(`备份导入失败：${error.message}`, 7000);
  }
}

function parseBackup(backup) {
  if (!backup || typeof backup !== "object") throw new Error("这不是有效的备份文件。");
  let books;
  let savedWords;
  let positions;
  let customDictionary = null;
  if (backup.backupVersion === 2) {
    if (backup.app !== "text-reader") throw new Error("这不是 Text Reader 备份文件。");
    ({ books, savedWords, positions } = backup.data || {});
    if (Array.isArray(backup.data?.customDictionary)) {
      customDictionary = backup.data.customDictionary.filter((entry) => !isPublicDictionarySource(entry?.source));
    }
  } else if (backup.version === 1 && backup.stores) {
    books = backup.stores.books;
    savedWords = (backup.stores.highlights || []).map(legacyHighlightToSavedWord);
    positions = backup.stores.positions;
    customDictionary = (backup.stores.dictionary || []).filter((entry) => !isPublicDictionarySource(entry?.source));
  } else {
    throw new Error("不支持这个备份版本。");
  }
  if (![books, savedWords, positions].every(Array.isArray)) throw new Error("备份内容不完整。");
  if (books.some((book) => !book.id || typeof book.text !== "string")) throw new Error("备份中的书籍数据无效。");
  if (savedWords.some((word) => !word.id || !word.bookId || !Number.isFinite(Number(word.start)) || !Number.isFinite(Number(word.end)))) {
    throw new Error("备份中的生词数据无效。");
  }
  if (customDictionary?.some((entry) => !entry?.id || !entry.normalizedTerm || !Array.isArray(entry.definitions))) {
    throw new Error("备份中的自定义词典数据无效。");
  }
  return { books, savedWords, positions, customDictionary };
}

function configureSync() {
  try {
    saveSyncConfig(els.supabaseUrl.value, els.supabaseKey.value);
    els.supabaseKey.value = "";
    state.syncError = "";
    state.syncNotice = "同步服务已保存。以后把配置写入 src/config.js，就不依赖手机浏览器保存它。";
    renderSyncStatus();
    initializeSync(handleAuthChange).catch((error) => {
      state.syncError = error.message;
      renderSyncStatus();
    });
  } catch (error) {
    state.syncError = error.message;
    renderSyncStatus();
  }
}

function removeSyncConfiguration() {
  if (!window.confirm("清除这台设备保存的同步服务配置？云端数据不会被删除。")) return;
  if (!clearSyncConfig()) {
    showToast("这个版本使用内置同步配置，不能在界面中清除。 ");
    return;
  }
  state.syncSession = null;
  state.syncNotice = "";
  state.syncError = "";
  renderSyncStatus();
}

async function handleSignIn() {
  await runSyncAction("正在登录…", async () => {
    const session = await signIn(els.syncEmail.value, els.syncPassword.value);
    els.syncPassword.value = "";
    state.syncSession = session;
    state.syncNotice = "这台设备已登录；正常关闭或换网络不会要求重新登录。";
  });
}

async function handleSignUp() {
  await runSyncAction("正在创建账号…", async () => {
    const data = await signUp(els.syncEmail.value, els.syncPassword.value);
    els.syncPassword.value = "";
    state.syncSession = data.session || null;
    state.syncNotice = data.session ? "账号已创建并登录。" : "账号已创建；如果项目开启邮件确认，请先检查邮箱。";
  });
}

async function handleSignOut() {
  await runSyncAction("正在退出…", async () => {
    await signOut();
    state.syncSession = null;
    state.syncNotice = "已退出登录。";
  });
}

async function handlePush() {
  await saveReadingPosition();
  await flushWrites();
  const bookCount = state.books.length;
  const wordCount = state.savedWords.length;
  if (!window.confirm(`上传会让本机数据覆盖云端。将上传 ${bookCount} 本书和 ${wordCount} 条生词；云端多余内容会删除。继续吗？`)) return;
  await runSyncAction("正在上传本机数据…", async () => {
    const meta = await pushDeviceToCloud((message) => {
      state.syncNotice = message;
      renderSyncStatus();
    });
    state.syncNotice = `上传完成：${meta.books} 本书，${meta.savedWords} 条生词。`;
    await refreshLastSyncStatus();
  });
}

async function handlePull() {
  await saveReadingPosition();
  await flushWrites();
  if (!window.confirm("从云端恢复会覆盖这台设备现有的书籍、生词和阅读进度。离线词典不会被删除。继续吗？")) return;
  await runSyncAction("正在从云端恢复…", async () => {
    const result = await pullCloudToDevice((message) => {
      state.syncNotice = message;
      renderSyncStatus();
    });
    await refreshAppData();
    state.syncNotice = `恢复完成：${result.books} 本书，${result.savedWords} 条生词。`;
    await refreshLastSyncStatus();
  });
}

async function runSyncAction(message, action) {
  if (state.syncBusy) return;
  state.syncBusy = true;
  state.syncError = "";
  state.syncNotice = message;
  setSyncButtonsBusy(true);
  renderSyncStatus();
  try {
    await action();
  } catch (error) {
    console.error(error);
    state.syncError = error.message || "同步操作失败。";
  } finally {
    state.syncBusy = false;
    setSyncButtonsBusy(false);
    renderSyncStatus();
  }
}

function setSyncButtonsBusy(busy) {
  for (const button of [
    els.syncSignIn, els.syncSignUp, els.syncSignOut, els.syncPush, els.syncPull,
    els.saveSupabaseConfig, els.clearSupabaseConfig
  ]) button.disabled = busy;
}

function handleAuthChange({ session }) {
  state.syncSession = session || null;
  state.syncError = "";
  renderSyncStatus();
}

function renderSyncStatus() {
  const config = getSyncConfig();
  const configured = Boolean(config.url && config.key);
  if (document.activeElement !== els.supabaseUrl) els.supabaseUrl.value = config.url || "";
  els.syncSetupDetails.hidden = config.embedded;
  if (!config.embedded && !configured) els.syncSetupDetails.open = true;
  if (!config.embedded && configured && !state.syncError) els.syncSetupDetails.open = false;

  els.syncSignedOut.hidden = true;
  els.syncSignedIn.hidden = true;
  if (!configured) {
    els.syncBadge.textContent = "未配置";
    els.syncBadge.dataset.status = "warn";
    els.syncStatus.textContent = state.syncError || "这个代码副本还没有绑定 Supabase。只需配置一次；部署时写入应用配置后，所有设备都不必再填 URL。";
    return;
  }
  if (state.syncBusy) {
    els.syncBadge.textContent = "同步中";
    els.syncBadge.dataset.status = "warn";
    els.syncStatus.textContent = state.syncNotice || "正在同步…";
  } else if (state.syncError) {
    els.syncBadge.textContent = "连接失败";
    els.syncBadge.dataset.status = "bad";
    els.syncStatus.textContent = state.syncError;
  } else if (state.syncSession) {
    els.syncBadge.textContent = "已连接";
    els.syncBadge.dataset.status = "good";
    els.syncStatus.textContent = state.syncNotice || "登录状态会自动恢复；同步仍由你手动选择方向。";
  } else {
    els.syncBadge.textContent = "待登录";
    els.syncBadge.dataset.status = "warn";
    els.syncStatus.textContent = state.syncNotice || "同步服务已准备好。登录一次后，正常关闭应用或切换网络不会退出。";
  }

  if (state.syncSession) {
    els.syncSignedIn.hidden = false;
    els.syncAccount.textContent = state.syncSession.user?.email || "当前账号";
  } else {
    els.syncSignedOut.hidden = false;
  }
}

async function refreshLastSyncStatus() {
  try {
    const meta = await getLastSync();
    els.syncLastStatus.textContent = meta?.at
      ? `上次${meta.direction === "push" ? "上传" : "恢复"}：${formatDateTime(meta.at)}`
      : "还没有完成过云端同步。";
  } catch {
    els.syncLastStatus.textContent = "";
  }
}

async function openSettingsFromReader() {
  await saveReadingPosition();
  closeLookupSheet();
  state.currentBook = null;
  state.currentBookWords = [];
  showView("settings", { focus: false });
}

function enqueueWrite(action, rollback) {
  const write = state.pendingWrites.catch(() => undefined).then(action);
  state.pendingWrites = write.catch((error) => {
    console.error("Local save failed", error);
    rollback?.();
    showToast(`本机保存失败：${error.message}`, 7000);
  });
  return state.pendingWrites;
}

function flushWrites() {
  return state.pendingWrites;
}

function createEmptyCard(title, message) {
  const item = document.createElement("li");
  item.className = "empty-card";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const text = document.createElement("span");
  text.textContent = message;
  item.append(strong, text);
  return item;
}

function createLocalId(prefix) {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Date.now().toString(36)}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function detectBookLanguage(text) {
  const sample = text.slice(0, 12000);
  const chinese = (sample.match(/[\u3400-\u9fff]/g) || []).length;
  const english = (sample.match(/[A-Za-z]/g) || []).length;
  return chinese > english ? "zh-CN" : "en";
}

function formatCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知时间" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function formatDateForFileName(date) {
  return date.toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function showToast(message, duration = 3200) {
  window.clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, duration);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register("./sw.js")
    .then((registration) => registration.update().catch(() => undefined))
    .catch((error) => {
      console.warn("Service worker registration failed", error);
    });
}
