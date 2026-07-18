import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js?v=41";
import {
  getAllRecords,
  getMeta,
  legacyHighlightToSavedWord,
  putMeta,
  replaceUserData
} from "./db.js";

const SUPABASE_CLIENT_URL = "https://esm.sh/@supabase/supabase-js@2";
const LEGACY_CONFIG_KEY = "text-reader-supabase-config";
const SYNC_META_KEY = "sync-last-success";
const PAGE_SIZE = 1000;
const WRITE_BATCH_SIZE = 100;

let clientPromise = null;
let clientSignature = "";
let authSubscription = null;
let authListener = null;

function embeddedConfig() {
  return {
    url: String(SUPABASE_URL || "").trim(),
    key: String(SUPABASE_PUBLISHABLE_KEY || "").trim(),
    embedded: Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY)
  };
}

export function getSyncConfig() {
  const builtIn = embeddedConfig();
  if (builtIn.embedded) return builtIn;

  try {
    const stored = JSON.parse(localStorage.getItem(LEGACY_CONFIG_KEY));
    const url = String(stored?.url || "").trim();
    const key = String(stored?.publishableKey || stored?.anonKey || "").trim();
    return { url, key, embedded: false };
  } catch {
    return { url: "", key: "", embedded: false };
  }
}

export function isSyncConfigured() {
  const config = getSyncConfig();
  return Boolean(config.url && config.key);
}

export function saveSyncConfig(url, key) {
  const cleanUrl = String(url || "").trim().replace(/\/$/, "");
  const cleanKey = String(key || "").trim();
  if (!/^https:\/\//i.test(cleanUrl)) throw new Error("请输入有效的 HTTPS Supabase Project URL。");
  if (cleanKey.length < 20) throw new Error("请输入有效的 Supabase publishable 或 anon key。");

  localStorage.setItem(LEGACY_CONFIG_KEY, JSON.stringify({ url: cleanUrl, anonKey: cleanKey }));
  resetClient();
}

export function clearSyncConfig() {
  if (embeddedConfig().embedded) return false;
  localStorage.removeItem(LEGACY_CONFIG_KEY);
  resetClient();
  return true;
}

function resetClient() {
  authSubscription?.unsubscribe?.();
  authSubscription = null;
  clientPromise = null;
  clientSignature = "";
}

export async function getSupabaseClient() {
  const config = getSyncConfig();
  if (!config.url || !config.key) throw new Error("同步服务尚未配置。");
  const signature = `${config.url}|${config.key}`;
  if (clientPromise && clientSignature === signature) return clientPromise;

  clientSignature = signature;
  clientPromise = import(SUPABASE_CLIENT_URL).then(({ createClient }) => {
    const client = createClient(config.url, config.key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    const { data } = client.auth.onAuthStateChange((event, session) => {
      authListener?.({ event, session });
    });
    authSubscription = data.subscription;
    return client;
  });
  const pendingClient = clientPromise;
  pendingClient.catch(() => {
    if (clientPromise === pendingClient && clientSignature === signature) resetClient();
  });
  return clientPromise;
}

export async function initializeSync(listener) {
  authListener = listener;
  if (!isSyncConfigured()) {
    listener?.({ event: "UNCONFIGURED", session: null });
    return null;
  }

  const client = await getSupabaseClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  listener?.({ event: "INITIAL_SESSION", session: data.session || null });
  return data.session || null;
}

export async function signIn(email, password) {
  const client = await getSupabaseClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: String(email || "").trim(),
    password: String(password || "")
  });
  if (error) throw error;
  return data.session;
}

export async function signUp(email, password) {
  const client = await getSupabaseClient();
  const { data, error } = await client.auth.signUp({
    email: String(email || "").trim(),
    password: String(password || "")
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const client = await getSupabaseClient();
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

async function requireUser(client) {
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error("请先登录再同步。");
  return data.user;
}

export async function pushDeviceToCloud(onProgress) {
  const client = await getSupabaseClient();
  const user = await requireUser(client);
  const [books, savedWords, positions] = await Promise.all([
    getAllRecords("books"),
    getAllRecords("savedWords"),
    getAllRecords("positions")
  ]);

  onProgress?.("正在读取云端现有数据…");
  const [remoteBooks, remoteWords, remotePositions] = await Promise.all([
    selectAllForUser(client, "tr_books", user.id, "book_id"),
    selectAllForUser(client, "tr_highlights", user.id, "highlight_id"),
    selectAllForUser(client, "tr_positions", user.id, "book_id")
  ]);

  onProgress?.("正在上传书籍…");
  await upsertRows(client, "tr_books", books.map((item) => serializeBook(item, user.id)), "user_id,book_id", 5);
  onProgress?.("正在上传生词…");
  await upsertRows(client, "tr_highlights", savedWords.map((item) => serializeSavedWord(item, user.id)), "user_id,highlight_id");
  onProgress?.("正在上传阅读进度…");
  await upsertRows(client, "tr_positions", positions.map((item) => serializePosition(item, user.id)), "user_id,book_id");

  onProgress?.("正在清理云端旧记录…");
  await deleteMissingRows(client, "tr_positions", user.id, "book_id", remotePositions, positions.map((item) => item.bookId));
  await deleteMissingRows(client, "tr_highlights", user.id, "highlight_id", remoteWords, savedWords.map((item) => item.id));
  await deleteMissingRows(client, "tr_books", user.id, "book_id", remoteBooks, books.map((item) => item.id));

  const meta = {
    key: SYNC_META_KEY,
    direction: "push",
    at: new Date().toISOString(),
    books: books.length,
    savedWords: savedWords.length
  };
  await putMeta(meta);
  return meta;
}

export async function pullCloudToDevice(onProgress) {
  const client = await getSupabaseClient();
  const user = await requireUser(client);

  onProgress?.("正在下载云端数据…");
  const [bookRows, wordRows, positionRows] = await Promise.all([
    selectAllForUser(client, "tr_books", user.id, "book_id"),
    selectAllForUser(client, "tr_highlights", user.id, "highlight_id"),
    selectAllForUser(client, "tr_positions", user.id, "book_id")
  ]);
  const snapshot = {
    books: bookRows.map(deserializeBook),
    savedWords: wordRows.map(deserializeSavedWord),
    positions: positionRows.map(deserializePosition)
  };

  onProgress?.("正在替换本机数据…");
  await replaceUserData(snapshot);
  const meta = {
    key: SYNC_META_KEY,
    direction: "pull",
    at: new Date().toISOString(),
    books: snapshot.books.length,
    savedWords: snapshot.savedWords.length
  };
  await putMeta(meta);
  return { ...meta, snapshot };
}

export function getLastSync() {
  return getMeta(SYNC_META_KEY);
}

async function selectAllForUser(client, tableName, userId, orderColumn) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from(tableName)
      .select("*")
      .eq("user_id", userId)
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function upsertRows(client, tableName, rows, onConflict, batchSize = WRITE_BATCH_SIZE) {
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const { error } = await client.from(tableName).upsert(batch, { onConflict });
    if (error) throw error;
  }
}

async function deleteMissingRows(client, tableName, userId, idColumn, remoteRows, localIds) {
  const local = new Set(localIds);
  const staleIds = remoteRows.map((row) => row[idColumn]).filter((id) => !local.has(id));
  for (let start = 0; start < staleIds.length; start += WRITE_BATCH_SIZE) {
    const batch = staleIds.slice(start, start + WRITE_BATCH_SIZE);
    const { error } = await client.from(tableName).delete().eq("user_id", userId).in(idColumn, batch);
    if (error) throw error;
  }
}

function serializeBook(book, userId) {
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

function deserializeBook(row) {
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

function serializeSavedWord(savedWord, userId) {
  const envelope = {
    schema: "saved-word-v1",
    kind: savedWord.kind || "word",
    term: savedWord.term || savedWord.surfaceText,
    normalizedTerm: savedWord.normalizedTerm || "",
    phonetic: savedWord.phonetic || "",
    definitions: Array.isArray(savedWord.definitions) ? savedWord.definitions : [],
    context: savedWord.context || "",
    legacyNote: savedWord.legacyNote || ""
  };
  return {
    user_id: userId,
    highlight_id: savedWord.id,
    book_id: savedWord.bookId,
    start_offset: savedWord.start,
    end_offset: savedWord.end,
    text: savedWord.surfaceText || savedWord.text || savedWord.term || "",
    color: savedWord.color || "yellow",
    note: JSON.stringify(envelope),
    created_at: savedWord.createdAt,
    updated_at: savedWord.updatedAt
  };
}

function deserializeSavedWord(row) {
  let envelope = null;
  try {
    const parsed = JSON.parse(row.note || "");
    if (parsed?.schema === "saved-word-v1") envelope = parsed;
  } catch {
    // Older notes remain available as legacyNote.
  }

  if (!envelope) {
    return legacyHighlightToSavedWord({
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
    });
  }

  return {
    id: row.highlight_id,
    kind: envelope.kind || "word",
    bookId: row.book_id,
    start: row.start_offset,
    end: row.end_offset,
    surfaceText: row.text,
    term: envelope.term || row.text,
    normalizedTerm: envelope.normalizedTerm || String(envelope.term || row.text).toLowerCase(),
    phonetic: envelope.phonetic || "",
    definitions: Array.isArray(envelope.definitions) ? envelope.definitions : [],
    context: envelope.context || "",
    color: row.color || "yellow",
    legacyNote: envelope.legacyNote || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncStatus: "synced"
  };
}

function serializePosition(position, userId) {
  const hasProgress = position.progress != null && position.progress !== "";
  const progress = Number(position.progress);
  const encoded = hasProgress && Number.isFinite(progress)
    ? -(1 + Math.min(1, Math.max(0, progress)))
    : Number(position.scrollTop) || 0;
  return {
    user_id: userId,
    book_id: position.bookId,
    scroll_top: encoded,
    updated_at: position.updatedAt
  };
}

function deserializePosition(row) {
  const encoded = Number(row.scroll_top) || 0;
  return {
    bookId: row.book_id,
    scrollTop: encoded < 0 ? 0 : encoded,
    progress: encoded < 0 ? Math.min(1, Math.max(0, -encoded - 1)) : null,
    updatedAt: row.updated_at,
    syncStatus: "synced"
  };
}
