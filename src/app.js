const DB_NAME = "text-reader";
const DB_VERSION = 3;
const APP_VERSION = "v39";
const DEFAULT_FONT_SIZE = 20;
const RENDER_CHUNK_SIZE = 2000;
const DICTIONARY_SEED_VERSION = "english-chinese-starter-v1";
const DICTIONARY_IMPORT_BATCH_SIZE = 500;
const BACKUP_VERSION = 1;
const DELETION_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ECDICT_SOURCE_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv";
const SUPABASE_CLIENT_URL = "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_CONFIG_KEY = "text-reader-supabase-config";

const starterDictionaryEntries = [
  {
    term: "hello",
    definitions: ["Chinese: 你好; an expression used as a greeting."]
  },
  {
    term: "world",
    definitions: ["Chinese: 世界; the earth, or all people and things."]
  },
  {
    term: "read",
    definitions: ["Chinese: 阅读; to look at and understand written words."]
  },
  {
    term: "book",
    definitions: ["Chinese: 书; a written or printed work."]
  }
];

const state = {
  db: null,
  books: [],
  currentBook: null,
  highlights: [],
  highlightsByBook: new Map(),
  renderedChunks: [],
  selectedRange: null,
  fontSize: Number(localStorage.getItem("reader-font-size")) || DEFAULT_FONT_SIZE,
  scrollSaveTimer: null,
  lastHighlightActionAt: 0,
  lastUnhighlightedRange: null,
  lookupRequestId: 0,
  lookupBodyText: "",
  libraryNeedsRender: false,
  pendingLocalWrite: Promise.resolve()
};

const els = {
  app: document.querySelector("#app"),
  fileInput: document.querySelector("#fileInput"),
  dictionaryInput: document.querySelector("#dictionaryInput"),
  installEcdict: document.querySelector("#installEcdict"),
  backupInput: document.querySelector("#backupInput"),
  exportData: document.querySelector("#exportData"),
  supabaseUrl: document.querySelector("#supabaseUrl"),
  supabaseAnonKey: document.querySelector("#supabaseAnonKey"),
  saveSupabaseConfig: document.querySelector("#saveSupabaseConfig"),
  syncEmail: document.querySelector("#syncEmail"),
  syncPassword: document.querySelector("#syncPassword"),
  syncSignUp: document.querySelector("#syncSignUp"),
  syncSignIn: document.querySelector("#syncSignIn"),
  syncSignOut: document.querySelector("#syncSignOut"),
  syncPush: document.querySelector("#syncPush"),
  syncPull: document.querySelector("#syncPull"),
  syncStatus: document.querySelector("#syncStatus"),
  bookList: document.querySelector("#bookList"),
  bookCount: document.querySelector("#bookCount"),
  reader: document.querySelector("#reader"),
  emptyState: document.querySelector("#emptyState"),
  readerTitle: document.querySelector("#readerTitle"),
  readerMeta: document.querySelector("#readerMeta"),
  selectionPanel: document.querySelector("#selectionPanel"),
  selectedText: document.querySelector("#selectedText"),
  lookupResult: document.querySelector("#lookupResult"),
  dictionaryStatus: document.querySelector("#dictionaryStatus"),
  highlightSelection: document.querySelector("#highlightSelection"),
  removeHighlight: document.querySelector("#removeHighlight"),
  fontDown: document.querySelector("#fontDown"),
  fontUp: document.querySelector("#fontUp"),
  closeBook: document.querySelector("#closeBook"),
  backToLibrary: document.querySelector("#backToLibrary")
};

init().catch((error) => {
  console.error(error);
  alert("The reader could not start. Check the browser console for details.");
});

async function init() {
  state.db = await openDatabase();
  document.documentElement.style.setProperty("--reader-font-size", `${state.fontSize}px`);
  bindEvents();
  loadSupabaseConfigIntoForm();
  await seedStarterDictionary();
  await renderDictionaryStatus();
  await refreshSyncStatus();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      window.location.reload();
    });
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  }

  await refreshLibrary();
}

function bindEvents() {
  els.fileInput.addEventListener("change", handleFileImport);
  els.dictionaryInput.addEventListener("change", handleDictionaryImport);
  els.installEcdict.addEventListener("click", installEcdictDictionary);
  els.backupInput.addEventListener("change", handleBackupImport);
  els.exportData.addEventListener("click", exportAppData);
  els.saveSupabaseConfig.addEventListener("click", saveSupabaseConfig);
  els.syncSignUp.addEventListener("click", signUpForSync);
  els.syncSignIn.addEventListener("click", signInForSync);
  els.syncSignOut.addEventListener("click", signOutFromSync);
  els.syncPush.addEventListener("click", pushToCloud);
  els.syncPull.addEventListener("click", pullFromCloud);
  els.reader.addEventListener("click", handleReaderClick);
  els.reader.addEventListener("mouseup", updateSelection);
  els.reader.addEventListener("touchend", () => window.setTimeout(updateSelection, 120));
  els.reader.addEventListener("keyup", updateSelection);
  els.reader.addEventListener("scroll", schedulePositionSave);
  els.highlightSelection.addEventListener("click", saveSelectedHighlight);
  els.removeHighlight.addEventListener("click", removeSelectedHighlights);
  els.selectionPanel.addEventListener("pointerup", (event) => event.stopPropagation());
  els.selectionPanel.addEventListener("touchend", (event) => event.stopPropagation());
  els.selectionPanel.addEventListener("click", (event) => event.stopPropagation());
  els.fontDown.addEventListener("click", () => adjustFontSize(-1));
  els.fontUp.addEventListener("click", () => adjustFontSize(1));
  els.closeBook.addEventListener("click", closeBook);
  els.backToLibrary.addEventListener("click", showLibrary);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("books")) {
        db.createObjectStore("books", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("highlights")) {
        const store = db.createObjectStore("highlights", { keyPath: "id" });
        store.createIndex("bookId", "bookId");
      }
      if (!db.objectStoreNames.contains("positions")) {
        db.createObjectStore("positions", { keyPath: "bookId" });
      }
      if (!db.objectStoreNames.contains("dictionary")) {
        const store = db.createObjectStore("dictionary", { keyPath: "id" });
        store.createIndex("normalizedTerm", "normalizedTerm");
        store.createIndex("language", "language");
      }
      if (!db.objectStoreNames.contains("deletions")) {
        const store = db.createObjectStore("deletions", { keyPath: "id" });
        store.createIndex("entityType", "entityType");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(storeName, mode, callback) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = callback(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

function enqueueLocalWrite(action, onError) {
  const write = state.pendingLocalWrite.catch(() => undefined).then(action);
  state.pendingLocalWrite = write.catch((error) => {
    console.error("Local write failed", error);
    if (onError) onError(error);
    els.syncStatus.textContent = `Local save error: ${error.message || "unknown error"}`;
  });
  return state.pendingLocalWrite;
}

async function flushLocalWrites() {
  await state.pendingLocalWrite;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllFromStore(storeName) {
  return requestToPromise(state.db.transaction(storeName).objectStore(storeName).getAll());
}

function loadSupabaseConfigIntoForm() {
  const config = getSupabaseConfig();
  els.supabaseUrl.value = config.url;
  els.supabaseAnonKey.value = config.anonKey;
}

function getSupabaseConfig() {
  try {
    return JSON.parse(localStorage.getItem(SUPABASE_CONFIG_KEY)) || { url: "", anonKey: "" };
  } catch {
    return { url: "", anonKey: "" };
  }
}

function saveSupabaseConfig() {
  const config = {
    url: els.supabaseUrl.value.trim(),
    anonKey: els.supabaseAnonKey.value.trim()
  };

  localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(config));
  els.syncStatus.textContent = config.url && config.anonKey ? "Sync config saved." : "Sync is not configured.";
}

async function getSupabaseClient() {
  const config = getSupabaseConfig();
  if (!config.url || !config.anonKey) {
    throw new Error("Save Supabase project URL and anon key first.");
  }

  const { createClient } = await import(SUPABASE_CLIENT_URL);
  return createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
}

async function refreshSyncStatus() {
  const config = getSupabaseConfig();
  if (!config.url || !config.anonKey) {
    els.syncStatus.textContent = "Sync is not configured.";
    return;
  }

  try {
    const supabase = await getSupabaseClient();
    const { data } = await supabase.auth.getSession();
    els.syncStatus.textContent = data.session?.user?.email
      ? `Signed in as ${data.session.user.email}. Manual sync only. ${APP_VERSION}.`
      : "Sync configured. Sign in to sync.";
  } catch {
    els.syncStatus.textContent = "Sync config saved. Sign in to sync.";
  }
}

async function signUpForSync() {
  await runSyncAction("Creating account...", async (supabase) => {
    const { error } = await supabase.auth.signUp({
      email: els.syncEmail.value.trim(),
      password: els.syncPassword.value
    });
    if (error) throw error;
    els.syncStatus.textContent = "Account created. Check email if confirmation is enabled, then sign in.";
  });
}

async function signInForSync() {
  await runSyncAction("Signing in...", async (supabase) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: els.syncEmail.value.trim(),
      password: els.syncPassword.value
    });
    if (error) throw error;
    await refreshSyncStatus();
  });
}

async function signOutFromSync() {
  await runSyncAction("Signing out...", async (supabase) => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    els.syncStatus.textContent = "Signed out.";
  });
}

async function runSyncAction(status, action) {
  try {
    setSyncBusy(true);
    els.syncStatus.textContent = status;
    const supabase = await getSupabaseClient();
    await action(supabase);
  } catch (error) {
    console.error(error);
    els.syncStatus.textContent = `Sync error: ${error.message}`;
  } finally {
    setSyncBusy(false);
  }
}

function setSyncBusy(isBusy) {
  for (const button of [els.syncSignUp, els.syncSignIn, els.syncSignOut, els.syncPush, els.syncPull, els.saveSupabaseConfig]) {
    button.disabled = isBusy;
  }
}

async function getSignedInUser(supabase) {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error("Sign in before syncing.");
  return data.user;
}

async function pushToCloud() {
  await runSyncAction("Pushing this device to cloud...", async (supabase) => {
    const user = await getSignedInUser(supabase);
    await flushLocalWrites();
    await overwriteRemoteData(supabase, user.id);
    await clearAllDeletions();
    els.syncStatus.textContent = `Pushed this device to cloud at ${new Date().toLocaleTimeString()}.`;
  });
}

async function pullFromCloud() {
  await runSyncAction("Pulling cloud to this device...", async (supabase) => {
    const user = await getSignedInUser(supabase);
    await flushLocalWrites();
    const remoteData = await fetchRemoteData(supabase, user.id);
    await replaceLocalData(remoteData);
    await clearAllDeletions();
    await refreshAfterLocalOverwrite();
    els.syncStatus.textContent = `Pulled cloud to this device at ${new Date().toLocaleTimeString()}.`;
  });
}

async function fetchRemoteData(supabase, userId) {
  const [books, highlights, positions] = await Promise.all([
    selectAllForUser(supabase, "tr_books", userId),
    selectAllForUser(supabase, "tr_highlights", userId),
    selectAllForUser(supabase, "tr_positions", userId)
  ]);

  return { books, highlights, positions };
}

async function selectAllForUser(supabase, tableName, userId) {
  const { data, error } = await supabase.from(tableName).select("*").eq("user_id", userId);
  if (error) throw error;
  return data || [];
}

async function overwriteRemoteData(supabase, userId) {
  await deleteAllRemoteRows(supabase, "tr_positions", userId);
  await deleteAllRemoteRows(supabase, "tr_highlights", userId);
  await deleteAllRemoteRows(supabase, "tr_books", userId);
  await upsertRows(supabase, "tr_books", (await getAllFromStore("books")).map((book) => serializeBookForSync(book, userId)), "user_id,book_id");
  await upsertRows(supabase, "tr_highlights", (await getAllFromStore("highlights")).map((highlight) => serializeHighlightForSync(highlight, userId)), "user_id,highlight_id");
  await upsertRows(supabase, "tr_positions", (await getAllFromStore("positions")).map((position) => serializePositionForSync(position, userId)), "user_id,book_id");
}

async function replaceLocalData(remoteData) {
  await replaceStoreRecords("books", remoteData.books.map(deserializeBookFromSync));
  await replaceStoreRecords("highlights", remoteData.highlights.map(deserializeHighlightFromSync));
  await replaceStoreRecords("positions", remoteData.positions.map(deserializePositionFromSync));
}

async function replaceStoreRecords(storeName, records) {
  await transaction(storeName, "readwrite", (store) => {
    store.clear();
    for (const record of records) {
      store.put(record);
    }
  });
}

async function clearAllDeletions() {
  await transaction("deletions", "readwrite", (store) => store.clear());
}

async function refreshAfterLocalOverwrite() {
  const previousBookId = state.currentBook?.id;
  state.books = await requestToPromise(state.db.transaction("books").objectStore("books").getAll());
  state.books.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await refreshHighlightGroups();

  if (previousBookId) {
    state.currentBook = await requestToPromise(state.db.transaction("books").objectStore("books").get(previousBookId));
    state.highlights = state.currentBook ? await loadHighlights(previousBookId) : [];
  }

  if (!state.currentBook) {
    state.highlights = [];
    state.renderedChunks = [];
    els.app.classList.remove("reader-open");
  }

  renderLibrary();
  renderReader();
}

async function pushLocalDeletions(supabase, userId) {
  const deletions = await getAllFromStore("deletions");
  const expiredDeletions = [];

  for (const deletion of deletions) {
    if (deletion.entityType === "book") {
      await deleteRemoteRows(supabase, "tr_books", userId, "book_id", deletion.entityId);
      await deleteRemoteRows(supabase, "tr_highlights", userId, "book_id", deletion.entityId);
      await deleteRemoteRows(supabase, "tr_positions", userId, "book_id", deletion.entityId);
    } else if (deletion.entityType === "highlight") {
      await deleteRemoteRows(supabase, "tr_highlights", userId, "highlight_id", deletion.entityId);
    } else if (deletion.entityType === "highlightRange") {
      await deleteRemoteHighlightRange(supabase, userId, deletion);
    } else if (deletion.entityType === "position") {
      await deleteRemoteRows(supabase, "tr_positions", userId, "book_id", deletion.entityId);
    }

    if (isExpiredDeletion(deletion)) {
      expiredDeletions.push(deletion);
    }
  }

  if (expiredDeletions.length > 0) {
    await transaction("deletions", "readwrite", (store) => {
      for (const deletion of expiredDeletions) {
        store.delete(deletion.id);
      }
    });
  }
}

function isExpiredDeletion(deletion) {
  const deletedAt = new Date(deletion.deletedAt || 0).getTime();
  if (!Number.isFinite(deletedAt)) return false;
  return Date.now() - deletedAt > DELETION_TOMBSTONE_RETENTION_MS;
}

async function deleteRemoteRows(supabase, tableName, userId, columnName, value) {
  const { error } = await supabase.from(tableName).delete().eq("user_id", userId).eq(columnName, value);
  if (error) throw error;
}

async function deleteAllRemoteRows(supabase, tableName, userId) {
  const { error } = await supabase.from(tableName).delete().eq("user_id", userId);
  if (error) throw error;
}

async function deleteRemoteHighlightRange(supabase, userId, deletion) {
  if (!deletion.bookId || !Number.isFinite(deletion.start) || !Number.isFinite(deletion.end)) return;

  const { error } = await supabase
    .from("tr_highlights")
    .delete()
    .eq("user_id", userId)
    .eq("book_id", deletion.bookId)
    .lt("start_offset", deletion.end)
    .gt("end_offset", deletion.start);
  if (error) throw error;
}

async function upsertRows(supabase, tableName, rows, onConflict) {
  if (rows.length === 0) return;

  for (let start = 0; start < rows.length; start += 100) {
    const batch = rows.slice(start, start + 100);
    const { error } = await supabase.from(tableName).upsert(batch, { onConflict });
    if (error) throw error;
  }
}

async function mergeRemoteBooks(rows) {
  const storeRecords = await getAllFromStore("books");
  const localById = new Map(storeRecords.map((book) => [book.id, book]));

  await transaction("books", "readwrite", (store) => {
    for (const row of rows) {
      const book = deserializeBookFromSync(row);
      const local = localById.get(book.id);
      if (!local || isRemoteNewer(book.updatedAt, local.updatedAt)) {
        store.put(book);
      }
    }
  });
}

async function mergeRemoteHighlights(rows) {
  const storeRecords = await getAllFromStore("highlights");
  const localById = new Map(storeRecords.map((highlight) => [highlight.id, highlight]));
  const pendingDeletions = await getPendingDeletionIds("highlight");
  const pendingRangeDeletions = await getPendingHighlightRangeDeletions();

  await transaction("highlights", "readwrite", (store) => {
    for (const row of rows) {
      const highlight = deserializeHighlightFromSync(row);
      if (pendingDeletions.has(highlight.id)) continue;
      if (isBlockedByHighlightRangeDeletion(highlight, pendingRangeDeletions)) continue;
      const local = localById.get(highlight.id);
      if (!local || isRemoteNewer(highlight.updatedAt, local.updatedAt)) {
        store.put(highlight);
      }
    }
  });
}

async function mergeRemotePositions(rows) {
  const storeRecords = await getAllFromStore("positions");
  const localById = new Map(storeRecords.map((position) => [position.bookId, position]));

  await transaction("positions", "readwrite", (store) => {
    for (const row of rows) {
      const position = deserializePositionFromSync(row);
      const local = localById.get(position.bookId);
      if (!local || isRemoteNewer(position.updatedAt, local.updatedAt)) {
        store.put(position);
      }
    }
  });
}

function serializeBookForSync(book, userId) {
  return {
    user_id: userId,
    book_id: book.id,
    title: book.title,
    file_name: book.fileName,
    text: book.text,
    created_at: book.createdAt,
    updated_at: book.updatedAt
  };
}

function deserializeBookFromSync(row) {
  return {
    id: row.book_id,
    title: row.title,
    fileName: row.file_name,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncStatus: "synced"
  };
}

function serializeHighlightForSync(highlight, userId) {
  return {
    user_id: userId,
    highlight_id: highlight.id,
    book_id: highlight.bookId,
    start_offset: highlight.start,
    end_offset: highlight.end,
    text: highlight.text,
    color: highlight.color,
    note: highlight.note,
    created_at: highlight.createdAt,
    updated_at: highlight.updatedAt
  };
}

function deserializeHighlightFromSync(row) {
  return {
    id: row.highlight_id,
    bookId: row.book_id,
    start: row.start_offset,
    end: row.end_offset,
    text: row.text,
    color: row.color,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncStatus: "synced"
  };
}

function serializePositionForSync(position, userId) {
  return {
    user_id: userId,
    book_id: position.bookId,
    scroll_top: position.scrollTop,
    updated_at: position.updatedAt
  };
}

function deserializePositionFromSync(row) {
  return {
    bookId: row.book_id,
    scrollTop: row.scroll_top,
    updatedAt: row.updated_at,
    syncStatus: "synced"
  };
}

function isRemoteNewer(remoteUpdatedAt, localUpdatedAt) {
  return new Date(remoteUpdatedAt).getTime() > new Date(localUpdatedAt || 0).getTime();
}

async function recordDeletion(entityType, entityId, metadata = {}) {
  await transaction("deletions", "readwrite", (store) =>
    store.put({
      id: `${entityType}:${entityId}`,
      entityType,
      entityId,
      deletedAt: new Date().toISOString(),
      ...metadata
    })
  );
}

async function getPendingDeletionIds(entityType) {
  const deletions = await getAllFromStore("deletions");
  return new Set(
    deletions
      .filter((deletion) => deletion.entityType === entityType)
      .map((deletion) => deletion.entityId)
  );
}

async function getPendingHighlightRangeDeletions() {
  const deletions = await getAllFromStore("deletions");
  return deletions.filter((deletion) => deletion.entityType === "highlightRange");
}

function isBlockedByHighlightRangeDeletion(highlight, deletions) {
  return deletions.some((deletion) =>
    deletion.bookId === highlight.bookId
    && Number.isFinite(deletion.start)
    && Number.isFinite(deletion.end)
    && rangesOverlap(highlight.start, highlight.end, deletion.start, deletion.end)
  );
}

async function exportAppData() {
  await flushLocalWrites();

  const backup = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    stores: {
      books: await getAllFromStore("books"),
      highlights: await getAllFromStore("highlights"),
      positions: await getAllFromStore("positions"),
      dictionary: await getAllFromStore("dictionary"),
      deletions: await getAllFromStore("deletions")
    }
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `text-reader-backup-${formatDateForFileName(new Date())}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  els.dictionaryStatus.textContent = "Exported local backup.";
}

async function handleBackupImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    els.dictionaryStatus.textContent = `Importing backup ${file.name}...`;
    const backup = JSON.parse(await file.text());
    validateBackup(backup);

    await importStoreRecords("books", backup.stores.books);
    await importStoreRecords("highlights", backup.stores.highlights);
    await importStoreRecords("positions", backup.stores.positions);
    await importStoreRecords("dictionary", backup.stores.dictionary);
    await importStoreRecords("deletions", backup.stores.deletions || []);

    if (state.currentBook) {
      state.currentBook = await requestToPromise(state.db.transaction("books").objectStore("books").get(state.currentBook.id));
      state.highlights = state.currentBook ? await loadHighlights(state.currentBook.id) : [];
      renderReader();
    }

    await refreshLibrary();
    await renderDictionaryStatus();
    els.dictionaryStatus.textContent = `Imported backup ${file.name}.`;
  } catch (error) {
    console.error(error);
    els.dictionaryStatus.textContent = `Backup import failed: ${error.message}`;
  } finally {
    event.target.value = "";
  }
}

function validateBackup(backup) {
  if (!backup || typeof backup !== "object" || !backup.stores) {
    throw new Error("Backup file is not a Text Reader backup.");
  }

  for (const storeName of ["books", "highlights", "positions", "dictionary"]) {
    if (!Array.isArray(backup.stores[storeName])) {
      throw new Error(`Backup is missing ${storeName}.`);
    }
  }
}

async function importStoreRecords(storeName, records) {
  await transaction(storeName, "readwrite", (store) => {
    for (const record of records) {
      store.put(record);
    }
  });
}

function formatDateForFileName(date) {
  return date.toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

async function seedStarterDictionary() {
  if (localStorage.getItem("dictionary-seed-version") === DICTIONARY_SEED_VERSION) return;

  const now = new Date().toISOString();
  await clearStarterDictionaryEntries();

  await transaction("dictionary", "readwrite", (store) => {
    for (const entry of starterDictionaryEntries) {
      const normalizedTerm = normalizeDictionaryTerm(entry.term);
      store.put({
        id: `en:${normalizedTerm}`,
        normalizedTerm,
        term: entry.term,
        language: "en",
        definitions: entry.definitions,
        source: "starter",
        updatedAt: now
      });
    }
  });

  localStorage.setItem("dictionary-seed-version", DICTIONARY_SEED_VERSION);
}

function clearStarterDictionaryEntries() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("dictionary", "readwrite");
    const store = tx.objectStore("dictionary");
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.source === "starter") {
        cursor.delete();
      }
      cursor.continue();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function renderDictionaryStatus() {
  const count = await requestToPromise(state.db.transaction("dictionary").objectStore("dictionary").count());
  els.dictionaryStatus.textContent = `Offline English-Chinese dictionary has ${formatCount(count)} entries.`;
}

async function handleDictionaryImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    els.dictionaryStatus.textContent = `Importing ${file.name}...`;
    const text = await file.text();
    const entries = parseDictionaryFile(text, file.name);
    if (entries.length === 0) {
      throw new Error("No dictionary entries found.");
    }

    const imported = await saveDictionaryEntries(entries, file.name);
    els.dictionaryStatus.textContent = `Imported ${formatCount(imported)} entries from ${file.name}.`;
  } catch (error) {
    console.error(error);
    els.dictionaryStatus.textContent = `Dictionary import failed: ${error.message}`;
  } finally {
    event.target.value = "";
  }
}

async function installEcdictDictionary() {
  els.installEcdict.disabled = true;

  try {
    els.dictionaryStatus.textContent = "Downloading ECDICT...";
    const response = await fetch(ECDICT_SOURCE_URL);
    if (!response.ok) {
      throw new Error(`ECDICT download failed with HTTP ${response.status}.`);
    }

    const importer = createDictionaryBatchImporter("ECDICT");
    const rowHandler = createEcdictRowHandler(importer);
    const totalBytes = Number(response.headers.get("content-length")) || 0;
    let lastStatusAt = 0;

    if (response.body && "TextDecoderStream" in window) {
      await parseDelimitedStream(response.body, ",", async (row) => {
        await rowHandler(row);
        if (importer.count - lastStatusAt >= 10000) {
          lastStatusAt = importer.count;
          els.dictionaryStatus.textContent = `Installing ECDICT: ${formatCount(importer.count)} entries...`;
          await yieldToBrowser();
        }
      }, (receivedBytes) => {
        if (totalBytes > 0 && importer.count === 0) {
          const percent = Math.round((receivedBytes / totalBytes) * 100);
          els.dictionaryStatus.textContent = `Downloading ECDICT ${percent}%...`;
        }
      });
    } else {
      const text = await response.text();
      const rows = parseDelimitedRows(text, ",");
      for (const row of rows) {
        await rowHandler(row);
        if (importer.count - lastStatusAt >= 10000) {
          lastStatusAt = importer.count;
          els.dictionaryStatus.textContent = `Installing ECDICT: ${formatCount(importer.count)} entries...`;
          await yieldToBrowser();
        }
      }
    }

    await importer.flush();
    await renderDictionaryStatus();
    els.dictionaryStatus.textContent = `Installed ECDICT with ${formatCount(importer.count)} entries.`;
  } catch (error) {
    console.error(error);
    els.dictionaryStatus.textContent = `ECDICT install failed: ${error.message}`;
  } finally {
    els.installEcdict.disabled = false;
  }
}

function parseDictionaryFile(text, fileName) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (fileName.toLowerCase().endsWith(".json") || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return parseDictionaryJson(trimmed);
  }

  return parseDictionaryTable(trimmed, fileName);
}

function parseDictionaryJson(text) {
  const raw = JSON.parse(text);
  const rows = Array.isArray(raw) ? raw : raw.entries;
  if (!Array.isArray(rows)) {
    throw new Error("JSON dictionary must be an array or an object with an entries array.");
  }

  return rows.map((row) =>
    normalizeDictionaryImportEntry({
      term: row.term ?? row.word ?? row.english ?? row.en,
      definition: row.definition ?? row.definitions ?? row.translation ?? row.chinese ?? row.zh,
      phonetic: row.phonetic ?? row.pronunciation ?? row.ipa
    })
  ).filter(Boolean);
}

function parseDictionaryTable(text, fileName) {
  const delimiter = fileName.toLowerCase().endsWith(".tsv") || text.includes("\t") ? "\t" : ",";
  const rows = parseDelimitedRows(text, delimiter);
  if (rows.length === 0) return [];

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const hasHeader = header.some((cell) => ["word", "term", "english", "en"].includes(cell));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const termIndex = hasHeader ? findHeaderIndex(header, ["term", "word", "english", "en"]) : 0;
  const definitionIndex = hasHeader ? findHeaderIndex(header, ["definition", "definitions", "translation", "chinese", "zh"]) : 1;
  const phoneticIndex = hasHeader ? findHeaderIndex(header, ["phonetic", "pronunciation", "ipa"]) : -1;

  if (termIndex < 0 || definitionIndex < 0) {
    throw new Error("Dictionary table needs word/term and definition/translation columns.");
  }

  return dataRows.map((row) =>
    normalizeDictionaryImportEntry({
      term: row[termIndex],
      definition: row[definitionIndex],
      phonetic: phoneticIndex >= 0 ? row[phoneticIndex] : ""
    })
  ).filter(Boolean);
}

function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function findHeaderIndex(header, names) {
  return header.findIndex((cell) => names.includes(cell));
}

function normalizeDictionaryImportEntry(entry) {
  const term = String(entry.term || "").trim();
  const normalizedTerm = normalizeDictionaryTerm(term);
  if (!term || !normalizedTerm || hasChinese(term)) return null;

  const definitions = normalizeDefinitions(entry.definition);
  if (definitions.length === 0) return null;

  return {
    term,
    normalizedTerm,
    phonetic: String(entry.phonetic || "").trim(),
    definitions
  };
}

function normalizeDefinitions(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/\s*(?:;|\||\n)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function saveDictionaryEntries(entries, sourceName) {
  const importer = createDictionaryBatchImporter(sourceName);
  for (const entry of entries) {
    await importer.add(entry);
  }
  await importer.flush();
  return importer.count;
}

function createDictionaryBatchImporter(sourceName) {
  let batch = [];
  let imported = 0;
  const now = new Date().toISOString();

  async function flush() {
    if (batch.length === 0) return;
    const batchToSave = batch;
    batch = [];
    await transaction("dictionary", "readwrite", (store) => {
      for (const entry of batchToSave) {
        store.put({
          id: `en:${entry.normalizedTerm}`,
          normalizedTerm: entry.normalizedTerm,
          term: entry.term,
          language: "en",
          phonetic: entry.phonetic,
          definitions: entry.definitions,
          source: sourceName,
          updatedAt: now
        });
        imported += 1;
      }
    });
  }

  return {
    get count() {
      return imported + batch.length;
    },
    async add(entry) {
      if (!entry) return;
      batch.push(entry);
      if (batch.length >= DICTIONARY_IMPORT_BATCH_SIZE) {
        await flush();
      }
    },
    flush
  };
}

function createEcdictRowHandler(importer) {
  let header = null;
  let termIndex = -1;
  let translationIndex = -1;
  let phoneticIndex = -1;

  return async (row) => {
    if (!header) {
      header = row.map((cell) => cell.trim().toLowerCase());
      termIndex = findHeaderIndex(header, ["word"]);
      translationIndex = findHeaderIndex(header, ["translation"]);
      phoneticIndex = findHeaderIndex(header, ["phonetic"]);
      if (termIndex < 0 || translationIndex < 0) {
        throw new Error("ECDICT CSV is missing word or translation columns.");
      }
      return;
    }

    await importer.add(normalizeDictionaryImportEntry({
      term: row[termIndex],
      definition: row[translationIndex],
      phonetic: phoneticIndex >= 0 ? row[phoneticIndex] : ""
    }));
  };
}

async function parseDelimitedStream(stream, delimiter, onRow, onProgress) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let row = [];
  let cell = "";
  let inQuotes = false;
  let receivedBytes = 0;

  async function emitRow() {
    row.push(cell);
    if (row.some((value) => value.trim())) {
      await onRow(row);
    }
    row = [];
    cell = "";
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    receivedBytes += value.length;
    onProgress?.(receivedBytes);

    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      const next = value[index + 1];

      if (char === '"' && inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        row.push(cell);
        cell = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") index += 1;
        await emitRow();
      } else {
        cell += char;
      }
    }
  }

  if (cell || row.length > 0) {
    await emitRow();
  }
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function refreshLibrary() {
  state.books = await requestToPromise(state.db.transaction("books").objectStore("books").getAll());
  state.books.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await refreshHighlightGroups();
  renderLibrary();
}

async function refreshCurrentBookState() {
  if (!state.currentBook) return;

  state.currentBook = await requestToPromise(state.db.transaction("books").objectStore("books").get(state.currentBook.id));
  state.highlights = state.currentBook ? await loadHighlights(state.currentBook.id) : [];
  if (state.currentBook) {
    state.highlightsByBook.set(state.currentBook.id, state.highlights);
  }
}

function renderLibrary() {
  state.libraryNeedsRender = false;
  els.bookCount.textContent = String(state.books.length);
  els.bookList.innerHTML = "";

  if (state.books.length === 0) {
    const empty = document.createElement("p");
    empty.className = "book-item";
    empty.textContent = "No books imported yet.";
    els.bookList.append(empty);
    return;
  }

  for (const book of state.books) {
    els.bookList.append(createBookCard(book));
  }
}

function createBookCard(book) {
  const highlights = state.highlightsByBook.get(book.id) || [];
  const card = document.createElement("div");
  card.className = "book-card";
  card.dataset.bookId = book.id;
  card.setAttribute("aria-current", state.currentBook?.id === book.id ? "true" : "false");

  const openButton = document.createElement("button");
  openButton.className = "book-item";
  openButton.type = "button";
  openButton.innerHTML = `
    <strong></strong>
    <span></span>
  `;
  openButton.querySelector("strong").textContent = book.title;
  openButton.querySelector("span").textContent = `${formatCount(book.text.length)} characters · ${formatCount(highlights.length)} highlights`;
  openButton.addEventListener("click", () => openBook(book.id));

  const actions = document.createElement("div");
  actions.className = "book-actions";

  const removeButton = document.createElement("button");
  removeButton.className = "book-remove";
  removeButton.type = "button";
  removeButton.textContent = "Remove book";
  removeButton.addEventListener("click", () => removeBook(book.id));

  actions.append(removeButton);
  card.append(openButton, actions, createBookHighlightList(book.id, highlights));
  return card;
}

function updateBookCard(bookId) {
  if (isLibraryHiddenBehindReader()) {
    state.libraryNeedsRender = true;
    return;
  }

  const book = state.books.find((item) => item.id === bookId);
  const currentCard = [...els.bookList.querySelectorAll(".book-card")]
    .find((card) => card.dataset.bookId === bookId);
  if (!book || !currentCard) {
    renderLibrary();
    return;
  }

  currentCard.replaceWith(createBookCard(book));
}

async function refreshHighlightGroups() {
  const highlights = await requestToPromise(state.db.transaction("highlights").objectStore("highlights").getAll());
  const groups = new Map();

  for (const highlight of highlights.sort((a, b) => a.start - b.start)) {
    if (!groups.has(highlight.bookId)) groups.set(highlight.bookId, []);
    groups.get(highlight.bookId).push(highlight);
  }

  state.highlightsByBook = groups;
}

function createBookHighlightList(bookId, highlights) {
  const list = document.createElement("div");
  list.className = "highlight-list";

  if (highlights.length === 0) {
    const empty = document.createElement("p");
    empty.className = "highlight-empty";
    empty.textContent = "No highlights in this book yet.";
    list.append(empty);
    return list;
  }

  const visible = highlights.slice(0, 3);
  for (const highlight of visible) {
    list.append(createHighlightItem(bookId, highlight));
  }

  if (highlights.length > 3) {
    const hidden = document.createElement("div");
    hidden.className = "highlight-list";
    hidden.hidden = true;
    for (let i = 3; i < highlights.length; i++) {
      hidden.append(createHighlightItem(bookId, highlights[i]));
    }

    const toggle = document.createElement("button");
    toggle.className = "highlight-toggle";
    toggle.type = "button";
    toggle.textContent = `Show all ${highlights.length} highlights`;
    toggle.addEventListener("click", () => {
      hidden.hidden = !hidden.hidden;
      toggle.textContent = hidden.hidden
        ? `Show all ${highlights.length} highlights`
        : "Show fewer";
    });

    list.append(hidden, toggle);
  }

  return list;
}

function createHighlightItem(bookId, highlight) {
  const item = document.createElement("div");
  item.className = "highlight-item";

  const jumpButton = document.createElement("button");
  jumpButton.className = "highlight-jump";
  jumpButton.type = "button";
  jumpButton.textContent = getHighlightPreview(highlight);
  jumpButton.addEventListener("click", () => jumpToHighlight(bookId, highlight));

  const removeButton = document.createElement("button");
  removeButton.className = "highlight-remove";
  removeButton.type = "button";
  removeButton.title = "Remove highlight";
  removeButton.setAttribute("aria-label", `Remove highlight ${highlight.text}`);
  removeButton.textContent = "X";
  removeButton.addEventListener("click", () => removeHighlightById(bookId, highlight.id));

  item.append(jumpButton, removeButton);
  return item;
}

async function handleFileImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    els.dictionaryStatus.textContent = `Importing ${file.name}...`;
    const text = await decodeTextFile(file);
    const normalizedText = normalizeText(text);
    const id = await hashText(normalizedText);
    const now = new Date().toISOString();
    const existing = await requestToPromise(state.db.transaction("books").objectStore("books").get(id));
    const book = {
      id,
      title: file.name.replace(/\.txt$/i, "") || "Untitled",
      fileName: file.name,
      text: normalizedText,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      syncStatus: "local"
    };

    await transaction("books", "readwrite", (store) => store.put(book));
    event.target.value = "";
    await refreshLibrary();
    await openBook(id);
    markLocalChanges();
    await renderDictionaryStatus();
  } catch (error) {
    console.error("Book import failed", error);
    els.dictionaryStatus.textContent = `Book import failed: ${error.message || "unknown error"}`;
  }
}

async function decodeTextFile(file) {
  const buffer = await file.arrayBuffer();
  const encodings = ["utf-8", "gb18030", "gbk", "big5"];

  for (const encoding of encodings) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch {
      // Try the next likely TXT encoding.
    }
  }

  return new TextDecoder("utf-8").decode(buffer);
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

async function hashText(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = crypto.subtle
    ? await crypto.subtle.digest("SHA-256", bytes)
    : sha256Bytes(bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256Bytes(bytes) {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + constants[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  for (let index = 0; index < hash.length; index += 1) {
    outputView.setUint32(index * 4, hash[index]);
  }
  return output.buffer;
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

async function openBook(bookId) {
  const book = await requestToPromise(state.db.transaction("books").objectStore("books").get(bookId));
  if (!book) return;

  state.currentBook = book;
  state.highlights = await loadHighlights(bookId);
  if (usesSinglePaneLayout()) {
    state.libraryNeedsRender = true;
  } else {
    renderLibrary();
  }
  renderReader();
  els.app.classList.add("reader-open");

  const position = await requestToPromise(state.db.transaction("positions").objectStore("positions").get(bookId));
  window.requestAnimationFrame(() => {
    els.reader.scrollTop = position?.scrollTop || 0;
  });
}

function showLibrary() {
  els.app.classList.remove("reader-open");
  if (state.libraryNeedsRender) {
    renderLibrary();
  }
}

function usesSinglePaneLayout() {
  return window.matchMedia("(max-width: 1180px), (hover: none) and (pointer: coarse)").matches;
}

function isLibraryHiddenBehindReader() {
  return usesSinglePaneLayout() && els.app.classList.contains("reader-open");
}

async function removeBook(bookId) {
  const book = state.books.find((item) => item.id === bookId);
  if (!book) return;

  const confirmed = window.confirm(`Remove "${book.title}" and its highlights from this device?`);
  if (!confirmed) return;

  await transaction("books", "readwrite", (store) => store.delete(bookId));
  await transaction("positions", "readwrite", (store) => store.delete(bookId));
  await deleteHighlightsForBook(bookId);

  if (state.currentBook?.id === bookId) {
    state.currentBook = null;
    state.highlights = [];
    els.app.classList.remove("reader-open");
    renderReader();
  }

  await refreshLibrary();
  markLocalChanges();
}

function deleteHighlightsForBook(bookId) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("highlights", "readwrite");
    const index = tx.objectStore("highlights").index("bookId");
    const request = index.openCursor(bookId);

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHighlights(bookId) {
  const tx = state.db.transaction("highlights");
  const index = tx.objectStore("highlights").index("bookId");
  const highlights = await requestToPromise(index.getAll(bookId));
  return highlights.sort((a, b) => a.start - b.start);
}

function renderReader() {
  const { currentBook } = state;
  clearSelectionPanel();
  state.renderedChunks = [];

  els.emptyState.hidden = Boolean(currentBook);
  els.reader.classList.toggle("is-active", Boolean(currentBook));
  els.readerTitle.textContent = currentBook?.title || "Import a TXT book";
  els.readerMeta.textContent = currentBook ? `${formatCount(currentBook.text.length)} characters` : "No book selected";

  if (!currentBook) {
    els.reader.innerHTML = "";
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const chunk of getReaderChunks(currentBook.text)) {
    fragment.append(createTextSegment(chunk.text, chunk.start));
  }

  els.reader.replaceChildren(fragment);
}

function getReaderChunks(text) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + RENDER_CHUNK_SIZE, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start) end = newline + 1;
    }
    chunks.push({ start, text: text.slice(start, end) });
    start = end;
  }

  return chunks;
}

function createTextSegment(text, start) {
  const el = document.createElement("span");
  el.dataset.start = String(start);
  el.dataset.end = String(start + text.length);
  renderChunkContent(el, text, start);
  state.renderedChunks.push({ element: el, start, end: start + text.length });
  return el;
}

function renderChunkContent(el, text, start) {
  const end = start + text.length;
  const highlights = state.highlights
    .filter((highlight) => rangesOverlap(highlight.start, highlight.end, start, end))
    .sort((a, b) => a.start - b.start);
  const children = [];
  let cursor = 0;

  for (const highlight of highlights) {
    const localStart = Math.max(0, highlight.start - start, cursor);
    const localEnd = Math.min(text.length, highlight.end - start);
    if (localEnd <= localStart) continue;

    if (localStart > cursor) {
      children.push(document.createTextNode(text.slice(cursor, localStart)));
    }

    const mark = document.createElement("mark");
    mark.dataset.highlightStart = String(start + localStart);
    mark.dataset.highlightEnd = String(start + localEnd);
    mark.textContent = text.slice(localStart, localEnd);
    children.push(mark);
    cursor = localEnd;
  }

  if (cursor < text.length) {
    children.push(document.createTextNode(text.slice(cursor)));
  }

  el.replaceChildren(...children);
}

async function handleReaderClick(event) {
  if (!state.currentBook) return;

  const selectedRange = getActiveReaderSelectionRange();
  if (selectedRange) {
    await showLookupPanel(selectedRange);
    return;
  }

  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;

  const range = getClickRange(event);
  if (range) {
    const offset = getReaderOffset(range.startContainer, range.startOffset);
    const wordRange = offset == null ? null : getWordRangeAtOffset(state.currentBook.text, offset);
    if (wordRange) {
      await lookupSelectedWord(wordRange);
      return;
    }
  }

  if (!els.selectionPanel.hidden) {
    clearSelectionPanel();
  }
}

function getClickRange(event) {
  if (document.caretRangeFromPoint) {
    return document.caretRangeFromPoint(event.clientX, event.clientY);
  }

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
  let start = offset;
  let end = offset;

  while (start > 0 && /[A-Za-z']/.test(text[start - 1])) {
    start -= 1;
  }
  while (end < text.length && /[A-Za-z']/.test(text[end])) {
    end += 1;
  }

  const selected = text.slice(start, end).trim();
  if (!selected || !/[A-Za-z]/.test(selected)) return null;

  return { start, end, text: selected };
}

function getHighlightPreview(highlight) {
  const text = highlight.text.replace(/\s+/g, " ").trim();
  if (text.length <= 80) return text;
  return `${text.slice(0, 77)}...`;
}

async function jumpToHighlight(bookId, highlight) {
  if (state.currentBook?.id !== bookId) {
    await openBook(bookId);
  }

  els.app.classList.add("reader-open");
  window.requestAnimationFrame(() => focusRenderedHighlight(highlight));
}

function focusRenderedHighlight(highlight) {
  const chunk = state.renderedChunks.find((item) =>
    rangesOverlap(item.start, item.end, highlight.start, highlight.end)
  );
  const target = chunk ? findHighlightMarkInChunk(chunk, highlight) || chunk.element : null;
  if (!target) return;

  target.scrollIntoView({ block: "center" });
  target.classList.add("is-focused");
  window.setTimeout(() => target.classList.remove("is-focused"), 1200);
}

function findHighlightMarkInChunk(chunk, highlight) {
  return [...chunk.element.querySelectorAll("mark")].find((mark) =>
    rangesOverlap(
      Number(mark.dataset.highlightStart),
      Number(mark.dataset.highlightEnd),
      highlight.start,
      highlight.end
    )
  );
}

async function updateSelection() {
  if (!state.currentBook) return;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return;
  }

  const selectedRange = getActiveReaderSelectionRange();
  if (!selectedRange) {
    clearSelectionPanel();
    return;
  }

  await showLookupPanel(selectedRange);
}

function getActiveReaderSelectionRange() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!els.reader.contains(range.commonAncestorContainer)) {
    return null;
  }

  const start = getReaderOffset(range.startContainer, range.startOffset);
  const end = getReaderOffset(range.endContainer, range.endOffset);
  if (start == null || end == null || start === end) {
    return null;
  }

  const normalizedStart = Math.min(start, end);
  const normalizedEnd = Math.max(start, end);
  const selected = state.currentBook.text.slice(normalizedStart, normalizedEnd).trim();
  if (!selected) {
    return null;
  }

  return {
    start: normalizedStart,
    end: normalizedEnd,
    text: selected
  };
}

async function lookupSelectedWord(range) {
  clearNativeSelection();
  const wasHighlighted = rangeHasHighlight(range);
  const initialPrefix = wasHighlighted ? "Already highlighted. " : "";
  await showLookupPanel(range, { statusPrefix: initialPrefix });
}

async function showLookupPanel(range, options = {}) {
  const requestId = state.lookupRequestId + 1;
  state.lookupRequestId = requestId;
  state.selectedRange = range;
  state.lookupBodyText = "";
  els.selectedText.textContent = range.text;
  els.lookupResult.textContent = "Looking up offline dictionary...";
  els.selectionPanel.hidden = false;
  syncSelectionActions();
  let result = "";
  try {
    result = await lookup(range.text);
  } catch (error) {
    console.error("Dictionary lookup failed", error);
    result = "Dictionary lookup failed, but the word was selected.";
  }
  if (requestId !== state.lookupRequestId) return;
  state.lookupBodyText = result;
  updateLookupPanelStatus(options.statusPrefix || "");
}

function updateLookupPanelStatus(statusPrefix) {
  els.lookupResult.textContent = `${statusPrefix || ""}${state.lookupBodyText}`;
  syncSelectionActions();
}

function getReaderOffset(node, offset) {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const segment = element?.closest?.("[data-start]");
  if (!segment || !els.reader.contains(segment)) return null;
  const textOffset = getTextOffsetWithinElement(segment, node, offset);
  if (textOffset == null) return null;
  return Number(segment.dataset.start) + textOffset;
}

function getTextOffsetWithinElement(root, node, offset) {
  if (!root.contains(node)) return null;

  const range = document.createRange();
  try {
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function clearNativeSelection() {
  const selection = window.getSelection();
  if (selection) selection.removeAllRanges();
}

async function lookup(text) {
  if (hasChinese(text)) {
    return "Chinese-to-English lookup is intentionally disabled. Select an English word for Chinese definitions.";
  }

  const candidates = getLookupCandidates(text);

  for (const candidate of candidates) {
    const entries = await lookupDictionaryEntries(candidate);
    if (entries.length > 0) {
      return entries.map(formatDictionaryEntry).join("\n");
    }
  }

  return "No offline dictionary match yet. Full English-Chinese dictionary import is the next phase.";
}

async function lookupDictionaryEntries(normalizedTerm) {
  const tx = state.db.transaction("dictionary");
  const index = tx.objectStore("dictionary").index("normalizedTerm");
  const entries = await requestToPromise(index.getAll(normalizedTerm));
  return entries.sort((a, b) => a.term.length - b.term.length);
}

function formatDictionaryEntry(entry) {
  const phonetic = entry.phonetic ? ` [${entry.phonetic}]` : "";
  return `${entry.term}${phonetic}: ${entry.definitions.join("; ")}`;
}

function getLookupCandidates(text) {
  const normalized = normalizeDictionaryTerm(text);
  if (!normalized) return [];

  const words = normalized.match(/[a-z]+(?:'[a-z]+)?/g) || [];
  const candidates = [normalized];
  for (const word of words) {
    candidates.push(word, ...getEnglishBaseCandidates(word));
  }
  return [...new Set(candidates.filter(Boolean))];
}

function getEnglishBaseCandidates(word) {
  const candidates = [];

  if (word.endsWith("'s")) {
    candidates.push(word.slice(0, -2));
  }

  addPluralCandidates(word, candidates);
  addVerbCandidates(word, candidates);
  addComparisonCandidates(word, candidates);

  return candidates;
}

function addPluralCandidates(word, candidates) {
  if (word.length <= 3) return;

  if (word.endsWith("ies") && word.length > 4) {
    candidates.push(`${word.slice(0, -3)}y`);
  }
  if (word.endsWith("ves") && word.length > 4) {
    candidates.push(`${word.slice(0, -3)}f`, `${word.slice(0, -3)}fe`);
  }
  if (word.endsWith("es") && word.length > 3) {
    candidates.push(word.slice(0, -2));
  }
  if (word.endsWith("s") && !word.endsWith("ss")) {
    candidates.push(word.slice(0, -1));
  }
}

function addVerbCandidates(word, candidates) {
  if (word.endsWith("ying") && word.length > 5) {
    candidates.push(`${word.slice(0, -4)}ie`);
  }
  if (word.endsWith("ing") && word.length > 5) {
    const stem = word.slice(0, -3);
    candidates.push(stem, `${stem}e`, undoubleFinalConsonant(stem));
  }
  if (word.endsWith("ied") && word.length > 4) {
    candidates.push(`${word.slice(0, -3)}y`);
  }
  if (word.endsWith("ed") && word.length > 4) {
    const stem = word.slice(0, -2);
    candidates.push(stem, `${stem}e`, undoubleFinalConsonant(stem));
  }
}

function addComparisonCandidates(word, candidates) {
  if (word.endsWith("iest") && word.length > 5) {
    candidates.push(`${word.slice(0, -4)}y`);
  }
  if (word.endsWith("ier") && word.length > 4) {
    candidates.push(`${word.slice(0, -3)}y`);
  }
  if (word.endsWith("est") && word.length > 5) {
    const stem = word.slice(0, -3);
    candidates.push(stem, `${stem}e`, undoubleFinalConsonant(stem));
  }
  if (word.endsWith("er") && word.length > 4) {
    const stem = word.slice(0, -2);
    candidates.push(stem, `${stem}e`, undoubleFinalConsonant(stem));
  }
}

function undoubleFinalConsonant(stem) {
  if (stem.length < 3) return "";
  const last = stem.at(-1);
  const previous = stem.at(-2);
  if (last !== previous || !/[bcdfghjklmnpqrstvwxyz]/.test(last)) return "";
  return stem.slice(0, -1);
}

function normalizeDictionaryTerm(term) {
  return term
    .trim()
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .replace(/\s+/g, " ");
}

function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(text);
}

async function saveSelectedHighlight() {
  if (!state.currentBook || !state.selectedRange) {
    els.lookupResult.textContent = "No word is selected. Tap a word first, then tap Highlight.";
    return;
  }

  const range = state.selectedRange;
  if (wasJustUnhighlighted(range)) return;
  if (shouldIgnoreHighlightAction(250)) return;

  let saved = false;
  try {
    saved = await saveHighlightRange(range);
  } catch (error) {
    console.error("Highlight save failed", error);
    await showLookupPanel(range, {
      statusPrefix: "Highlight could not be saved. "
    });
    return;
  }

  updateLookupPanelStatus(saved ? "Highlighted. " : "Already highlighted. ");
}

function shouldIgnoreHighlightAction(minDelay = 250) {
  const nowMs = Date.now();
  if (nowMs - state.lastHighlightActionAt < minDelay) return true;
  state.lastHighlightActionAt = nowMs;
  return false;
}

function wasJustUnhighlighted(range) {
  const previous = state.lastUnhighlightedRange;
  if (!previous || !range) return false;
  return Date.now() - previous.at < 600 && rangesOverlap(previous.start, previous.end, range.start, range.end);
}

async function saveHighlightRange(range) {
  if (!state.currentBook || !range) return false;
  if (rangeHasHighlight(range)) return false;

  const bookId = state.currentBook.id;
  const now = new Date().toISOString();
  const highlight = {
    id: createLocalId("highlight"),
    bookId,
    start: range.start,
    end: range.end,
    text: range.text,
    color: "yellow",
    note: "",
    createdAt: now,
    updatedAt: now,
    syncStatus: "local"
  };

  setBookHighlights(bookId, [...state.highlights, highlight]);
  updateBookCard(bookId);
  applyRenderedHighlightsInRange(range);
  markLocalChanges();
  enqueueLocalWrite(
    () => transaction("highlights", "readwrite", (store) => store.put(highlight)),
    () => rollbackHighlightSave(bookId, highlight, range)
  );
  return true;
}

function rollbackHighlightSave(bookId, highlight, range) {
  setBookHighlights(
    bookId,
    (state.highlightsByBook.get(bookId) || []).filter((item) => item.id !== highlight.id)
  );
  updateBookCard(bookId);
  applyRenderedHighlightsInRange(range);
  syncSelectionActions();
}

function createLocalId(prefix) {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

async function removeSelectedHighlights() {
  if (shouldIgnoreHighlightAction(250)) return;
  if (!state.currentBook || !state.selectedRange) return;

  const range = state.selectedRange;
  const bookId = state.currentBook.id;
  const matchingHighlights = state.highlights.filter((highlight) =>
    rangesOverlap(highlight.start, highlight.end, range.start, range.end)
  );
  if (matchingHighlights.length === 0) {
    updateLookupPanelStatus("This selection is not highlighted. ");
    return;
  }
  state.lastUnhighlightedRange = {
    start: range.start,
    end: range.end,
    at: Date.now()
  };

  const matchingIds = new Set(matchingHighlights.map((highlight) => highlight.id));
  const updateRange = getMergedRange(range, matchingHighlights);
  setBookHighlights(
    bookId,
    state.highlights.filter((highlight) => !matchingIds.has(highlight.id))
  );
  updateBookCard(bookId);
  applyRenderedHighlightsInRange(updateRange);
  markLocalChanges();
  updateLookupPanelStatus("Unhighlighted. ");
  enqueueLocalWrite(
    () => transaction("highlights", "readwrite", (store) => {
      for (const highlight of matchingHighlights) {
        store.delete(highlight.id);
      }
    }),
    () => rollbackHighlightRemoval(bookId, matchingHighlights, updateRange)
  );
}

async function removeHighlightById(bookId, highlightId) {
  const removingFromCurrentBook = state.currentBook?.id === bookId;
  const highlight = await requestToPromise(state.db.transaction("highlights").objectStore("highlights").get(highlightId));

  const updateRange = highlight || { start: 0, end: 0 };
  setBookHighlights(
    bookId,
    (state.highlightsByBook.get(bookId) || []).filter((item) => item.id !== highlightId)
  );

  if (removingFromCurrentBook) {
    applyRenderedHighlightsInRange(updateRange);
  }

  updateBookCard(bookId);
  markLocalChanges();
  enqueueLocalWrite(
    () => transaction("highlights", "readwrite", (store) => store.delete(highlightId)),
    () => highlight ? rollbackHighlightRemoval(bookId, [highlight], updateRange) : undefined
  );
}

function rollbackHighlightRemoval(bookId, highlights, range) {
  setBookHighlights(bookId, [...(state.highlightsByBook.get(bookId) || []), ...highlights]);
  if (state.currentBook?.id === bookId) {
    applyRenderedHighlightsInRange(range);
  }
  updateBookCard(bookId);
  syncSelectionActions();
}

async function recordHighlightDeletion(highlight) {
  await recordDeletion("highlight", highlight.id, {
    bookId: highlight.bookId,
    start: highlight.start,
    end: highlight.end,
    text: highlight.text
  });
}

async function recordHighlightRangeDeletion(bookId, range) {
  await recordDeletion("highlightRange", getHighlightRangeDeletionId(bookId, range), {
    bookId,
    start: range.start,
    end: range.end,
    text: range.text
  });
}

function getHighlightRangeDeletionId(bookId, range) {
  return `${bookId}:${range.start}:${range.end}`;
}

async function refreshHighlightState(bookId) {
  await refreshHighlightGroups();
  if (state.currentBook?.id === bookId) {
    state.highlights = state.highlightsByBook.get(bookId) || [];
  }
}

function setBookHighlights(bookId, highlights) {
  const unique = new Map();
  for (const highlight of highlights) {
    unique.set(highlight.id, highlight);
  }

  const sorted = [...unique.values()]
    .filter((highlight) => highlight.end > highlight.start)
    .sort((a, b) => a.start - b.start);
  state.highlightsByBook.set(bookId, sorted);
  if (state.currentBook?.id === bookId) {
    state.highlights = sorted;
  }
}

function applyRenderedHighlightsInRange(range) {
  if (!state.currentBook || !range || state.renderedChunks.length === 0) return;

  const startIndex = findFirstRenderedChunkEndingAfter(range.start);
  for (let index = startIndex; index < state.renderedChunks.length; index += 1) {
    const chunk = state.renderedChunks[index];
    if (chunk.start >= range.end) break;
    renderChunkContent(
      chunk.element,
      state.currentBook.text.slice(chunk.start, chunk.end),
      chunk.start
    );
  }
}

function findFirstRenderedChunkEndingAfter(offset) {
  let low = 0;
  let high = state.renderedChunks.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (state.renderedChunks[mid].end <= offset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function getMergedRange(range, highlights) {
  return highlights.reduce(
    (merged, highlight) => ({
      start: Math.min(merged.start, highlight.start),
      end: Math.max(merged.end, highlight.end)
    }),
    { start: range.start, end: range.end }
  );
}

function syncSelectionActions() {
  const hasHighlight = state.selectedRange ? rangeHasHighlight(state.selectedRange) : false;

  els.removeHighlight.hidden = !hasHighlight;
  els.highlightSelection.hidden = hasHighlight;
}

function rangeHasHighlight(range) {
  if (!range) return false;
  return state.highlights.some((highlight) =>
    rangesOverlap(highlight.start, highlight.end, range.start, range.end)
  );
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function clearSelectionPanel() {
  state.lookupRequestId += 1;
  state.selectedRange = null;
  state.lookupBodyText = "";
  els.selectionPanel.hidden = true;
  els.removeHighlight.hidden = true;
  els.highlightSelection.hidden = false;
  const selection = window.getSelection();
  if (selection) selection.removeAllRanges();
}

async function closeBook() {
  if (!state.currentBook) return;
  await savePosition();
  state.currentBook = null;
  state.highlights = [];
  els.app.classList.remove("reader-open");
  renderLibrary();
  renderReader();
}

function schedulePositionSave() {
  if (!state.currentBook) return;
  window.clearTimeout(state.scrollSaveTimer);
  state.scrollSaveTimer = window.setTimeout(savePosition, 250);
}

async function savePosition() {
  if (!state.currentBook) return;

  await transaction("positions", "readwrite", (store) =>
    store.put({
      bookId: state.currentBook.id,
      scrollTop: els.reader.scrollTop,
      updatedAt: new Date().toISOString(),
      syncStatus: "local"
    })
  );
}

function markLocalChanges() {
  const config = getSupabaseConfig();
  els.syncStatus.textContent = config.url && config.anonKey
    ? "Local changes saved. Push to cloud when ready."
    : "Local changes saved on this device.";
}

function adjustFontSize(delta) {
  state.fontSize = Math.min(30, Math.max(16, state.fontSize + delta));
  localStorage.setItem("reader-font-size", String(state.fontSize));
  document.documentElement.style.setProperty("--reader-font-size", `${state.fontSize}px`);
}

function formatCount(value) {
  return new Intl.NumberFormat().format(value);
}
