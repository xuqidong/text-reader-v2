export const DB_NAME = "text-reader";
export const DB_VERSION = 4;

let database = null;

export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function openDatabase() {
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
      if (!db.objectStoreNames.contains("savedWords")) {
        const store = db.createObjectStore("savedWords", { keyPath: "id" });
        store.createIndex("bookId", "bookId");
        store.createIndex("normalizedTerm", "normalizedTerm");
        store.createIndex("bookTerm", ["bookId", "normalizedTerm"]);
        store.createIndex("createdAt", "createdAt");
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
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };

    request.onblocked = () => {
      reject(new Error("请关闭其他仍打开的 Text Reader 页面，然后重试升级。"));
    };
    request.onsuccess = () => {
      database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  });
}

export function runTransaction(storeNames, mode, callback) {
  if (!database) throw new Error("Database is not open.");
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];

  return new Promise((resolve, reject) => {
    const tx = database.transaction(names, mode);
    const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
    let result;

    try {
      result = callback(stores, tx);
    } catch (error) {
      tx.abort();
      reject(error);
      return;
    }

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error("Database transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("Database transaction was cancelled."));
  });
}

export function getRecord(storeName, key) {
  if (!database) throw new Error("Database is not open.");
  return requestToPromise(database.transaction(storeName).objectStore(storeName).get(key));
}

export function getAllRecords(storeName) {
  if (!database) throw new Error("Database is not open.");
  return requestToPromise(database.transaction(storeName).objectStore(storeName).getAll());
}

export function countRecords(storeName) {
  if (!database) throw new Error("Database is not open.");
  return requestToPromise(database.transaction(storeName).objectStore(storeName).count());
}

export function putRecord(storeName, record) {
  return runTransaction(storeName, "readwrite", ({ [storeName]: store }) => store.put(record));
}

export function deleteRecord(storeName, key) {
  return runTransaction(storeName, "readwrite", ({ [storeName]: store }) => store.delete(key));
}

export function getMeta(key) {
  return getRecord("meta", key);
}

export function putMeta(record) {
  return putRecord("meta", record);
}

export function getDictionaryEntry(normalizedTerm) {
  return getRecord("dictionary", `en:${normalizedTerm}`);
}

export function getSavedWordsForBook(bookId) {
  if (!database) throw new Error("Database is not open.");
  const index = database.transaction("savedWords").objectStore("savedWords").index("bookId");
  return requestToPromise(index.getAll(bookId));
}

export function isPublicDictionarySource(source) {
  const normalized = String(source || "").trim().toLowerCase();
  return normalized === "starter"
    || normalized === "ecdict"
    || normalized.startsWith("ecdict ")
    || normalized === "ecdict.csv";
}

export function saveDictionaryBatch(entries, manifest, { preserveCustom = false } = {}) {
  return runTransaction(["dictionary", "meta"], "readwrite", ({ dictionary, meta }) => {
    for (const entry of entries) {
      if (!preserveCustom) {
        dictionary.put(entry);
        continue;
      }
      const request = dictionary.get(entry.id);
      request.onsuccess = () => {
        const existing = request.result;
        if (!existing || isPublicDictionarySource(existing.source)) dictionary.put(entry);
      };
    }
    if (manifest) meta.put(manifest);
  });
}

export function mergeCustomDictionary(records) {
  return runTransaction("dictionary", "readwrite", ({ dictionary }) => {
    for (const record of records) dictionary.put(record);
  });
}

export function getCustomDictionaryRecords() {
  return runTransaction("dictionary", "readonly", ({ dictionary }) => {
    const records = [];
    const request = dictionary.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (!isPublicDictionarySource(cursor.value?.source)) records.push(cursor.value);
      cursor.continue();
    };
    return records;
  });
}

export function clearDictionary() {
  return runTransaction(["dictionary", "meta"], "readwrite", ({ dictionary, meta }) => {
    dictionary.clear();
    meta.delete("dictionary-core");
    meta.delete("dictionary-full");
  });
}

export function replaceUserData({ books, savedWords, positions }) {
  return runTransaction(["books", "savedWords", "positions"], "readwrite", (stores) => {
    stores.books.clear();
    stores.savedWords.clear();
    stores.positions.clear();
    for (const record of books) stores.books.put(record);
    for (const record of savedWords) stores.savedWords.put(record);
    for (const record of positions) stores.positions.put(record);
  });
}

export function importUserData({ books = [], savedWords = [], positions = [] }, replace = false) {
  return runTransaction(["books", "savedWords", "positions"], "readwrite", (stores) => {
    if (replace) {
      stores.books.clear();
      stores.savedWords.clear();
      stores.positions.clear();
    }
    for (const record of books) stores.books.put(record);
    for (const record of savedWords) stores.savedWords.put(record);
    for (const record of positions) stores.positions.put(record);
  });
}

export function deleteSavedWordRecords(ids) {
  return runTransaction("savedWords", "readwrite", ({ savedWords }) => {
    for (const id of ids) savedWords.delete(id);
  });
}

export function deleteBookAndRelated(bookId) {
  return runTransaction(["books", "savedWords", "positions"], "readwrite", (stores) => {
    stores.books.delete(bookId);
    stores.positions.delete(bookId);
    const request = stores.savedWords.index("bookId").openCursor(IDBKeyRange.only(bookId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });
}

function normalizeLegacyTerm(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/^[^a-z]+|[^a-z]+$/g, "");
}

export function legacyHighlightToSavedWord(highlight) {
  const surfaceText = String(highlight.text || "").trim();
  const isWord = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(surfaceText);
  const normalizedTerm = isWord ? normalizeLegacyTerm(surfaceText) : surfaceText.toLowerCase();

  return {
    id: highlight.id,
    kind: isWord ? "word" : "legacy-selection",
    bookId: highlight.bookId,
    start: Number(highlight.start) || 0,
    end: Number(highlight.end) || 0,
    surfaceText,
    term: surfaceText,
    normalizedTerm,
    phonetic: "",
    definitions: [],
    context: "",
    color: highlight.color || "yellow",
    legacyNote: highlight.note || "",
    createdAt: highlight.createdAt || new Date().toISOString(),
    updatedAt: highlight.updatedAt || highlight.createdAt || new Date().toISOString(),
    syncStatus: highlight.syncStatus || "local"
  };
}

export async function migrateLegacyHighlights() {
  const [legacy, saved] = await Promise.all([
    getAllRecords("highlights"),
    getAllRecords("savedWords")
  ]);
  if (legacy.length === 0) return 0;

  const savedIds = new Set(saved.map((item) => item.id));
  const missing = legacy.filter((item) => !savedIds.has(item.id)).map(legacyHighlightToSavedWord);
  await runTransaction(["highlights", "savedWords"], "readwrite", ({ highlights, savedWords }) => {
    for (const item of missing) savedWords.put(item);
    // v41 reads only savedWords. Clearing the migrated source prevents a word
    // deleted in v41 from being resurrected by the next startup migration.
    highlights.clear();
  });
  return missing.length;
}
