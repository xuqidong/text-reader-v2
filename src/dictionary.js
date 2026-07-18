import {
  countRecords,
  getDictionaryEntry,
  getMeta,
  putMeta,
  saveDictionaryBatch
} from "./db.js";

export const CORE_DICTIONARY_VERSION = "ecdict-core-2026-07";
export const CORE_DICTIONARY_COUNT = 40000;
export const FULL_DICTIONARY_VERSION = "ecdict-bc015ed2";

const CORE_DICTIONARY_URL = "./assets/dictionary-core.json";
const FULL_DICTIONARY_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/ecdict.csv";
const CORE_META_KEY = "dictionary-core";
const FULL_META_KEY = "dictionary-full";
const CORE_BATCH_SIZE = 1000;
const FULL_BATCH_SIZE = 500;
const LEGACY_FULL_DICTIONARY_MINIMUM = 700000;

let fullInstallPromise = null;

export function normalizeDictionaryTerm(term) {
  return String(term || "")
    .trim()
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .replace(/\s+/g, " ");
}

export function isSingleEnglishWord(text) {
  return /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(String(text || "").trim());
}

function splitDefinitions(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "")
    .replace(/\\n/g, "\n")
    .split(/\s*(?:\n|\|)\s*/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function dictionaryRecord(term, phonetic, definitions, source, updatedAt) {
  const normalizedTerm = normalizeDictionaryTerm(term);
  return {
    id: `en:${normalizedTerm}`,
    normalizedTerm,
    term: String(term || "").trim(),
    language: "en",
    phonetic: String(phonetic || "").trim(),
    definitions: splitDefinitions(definitions),
    source,
    updatedAt
  };
}

export async function getDictionaryInfo() {
  const [core, full, count] = await Promise.all([
    getMeta(CORE_META_KEY),
    getMeta(FULL_META_KEY),
    countRecords("dictionary")
  ]);
  return { core, full, count };
}

export async function prepareCoreDictionary({ force = false, onProgress } = {}) {
  let [existing, full, count] = await Promise.all([
    getMeta(CORE_META_KEY),
    getMeta(FULL_META_KEY),
    countRecords("dictionary")
  ]);
  if (!force && full?.status === "ready" && !(await dictionaryLooksComplete(count))) {
    full = {
      ...full,
      status: "failed",
      error: "完整词典记录不完整，可以继续安装补齐。",
      updatedAt: new Date().toISOString()
    };
    await putMeta(full);
  }
  if (!force && !existing && full?.status === "ready" && count >= CORE_DICTIONARY_COUNT) {
    existing = await adoptExistingCoreDictionary(count, full.source || "existing full dictionary");
  } else if (!force && !existing && !full && count >= LEGACY_FULL_DICTIONARY_MINIMUM) {
    if (await dictionaryLooksComplete(count)) {
      const now = new Date().toISOString();
      full = {
        key: FULL_META_KEY,
        version: "legacy-ecdict",
        status: "ready",
        source: "Existing ECDICT installation",
        sourceRows: count,
        importedCount: count,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        error: ""
      };
      await putMeta(full);
    }
  }
  if (!force && existing?.status === "ready" && existing.version === CORE_DICTIONARY_VERSION && count >= CORE_DICTIONARY_COUNT) {
    onProgress?.({ phase: "core", status: "ready", importedCount: existing.importedCount || CORE_DICTIONARY_COUNT });
    return existing;
  }

  const startedAt = new Date().toISOString();
  let manifest = {
    key: CORE_META_KEY,
    version: CORE_DICTIONARY_VERSION,
    status: "installing",
    importedCount: 0,
    expectedCount: CORE_DICTIONARY_COUNT,
    startedAt,
    updatedAt: startedAt,
    source: "ECDICT core"
  };
  await putMeta(manifest);
  onProgress?.({ phase: "core", status: "downloading", importedCount: 0 });

  try {
    const response = await fetch(CORE_DICTIONARY_URL, { cache: "force-cache" });
    if (!response.ok) throw new Error(`常用词典下载失败（HTTP ${response.status}）。`);
    const payload = await response.json();
    if (payload.version !== CORE_DICTIONARY_VERSION || !Array.isArray(payload.entries)) {
      throw new Error("常用词典文件版本不匹配。请刷新应用后重试。");
    }

    const now = new Date().toISOString();
    for (let start = 0; start < payload.entries.length; start += CORE_BATCH_SIZE) {
      const rows = payload.entries.slice(start, start + CORE_BATCH_SIZE);
      const records = rows.map(([term, phonetic, translation]) =>
        dictionaryRecord(term, phonetic, translation, "ECDICT core", now)
      );
      manifest = {
        ...manifest,
        status: "installing",
        importedCount: Math.min(start + rows.length, payload.entries.length),
        expectedCount: payload.entries.length,
        updatedAt: new Date().toISOString()
      };
      await saveDictionaryBatch(records, manifest, { preserveCustom: true });
      onProgress?.({ phase: "core", status: "installing", importedCount: manifest.importedCount, expectedCount: manifest.expectedCount });
      await yieldToBrowser();
    }

    manifest = {
      ...manifest,
      status: "ready",
      importedCount: payload.entries.length,
      expectedCount: payload.entries.length,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: ""
    };
    await putMeta(manifest);
    onProgress?.({ phase: "core", status: "ready", importedCount: manifest.importedCount });
    return manifest;
  } catch (error) {
    manifest = {
      ...manifest,
      status: "failed",
      error: error.message || "常用词典安装失败。",
      updatedAt: new Date().toISOString()
    };
    await putMeta(manifest).catch(() => undefined);
    onProgress?.({ phase: "core", status: "failed", error: manifest.error, importedCount: manifest.importedCount });
    throw error;
  }
}

async function dictionaryLooksComplete(count) {
  if (count < LEGACY_FULL_DICTIONARY_MINIMUM) return false;
  const tailEntries = await Promise.all([
    getDictionaryEntry("zyxel"),
    getDictionaryEntry("zyzzyva"),
    getDictionaryEntry("zzz")
  ]);
  return tailEntries.every(Boolean);
}

async function adoptExistingCoreDictionary(count, source) {
  const now = new Date().toISOString();
  const manifest = {
    key: CORE_META_KEY,
    version: CORE_DICTIONARY_VERSION,
    status: "ready",
    importedCount: Math.min(count, CORE_DICTIONARY_COUNT),
    expectedCount: CORE_DICTIONARY_COUNT,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    source,
    error: ""
  };
  await putMeta(manifest);
  return manifest;
}

export function installFullDictionary({ restart = false, onProgress } = {}) {
  if (fullInstallPromise) return fullInstallPromise;
  fullInstallPromise = runFullDictionaryInstall({ restart, onProgress }).finally(() => {
    fullInstallPromise = null;
  });
  return fullInstallPromise;
}

async function runFullDictionaryInstall({ restart, onProgress }) {
  const previous = await getMeta(FULL_META_KEY);
  const canResume = !restart
    && previous
    && previous.version === FULL_DICTIONARY_VERSION
    && ["installing", "failed"].includes(previous.status);
  const resumeSourceRows = canResume ? Number(previous.sourceRows) || 0 : 0;
  const resumeImported = canResume ? Number(previous.importedCount) || 0 : 0;
  const startedAt = canResume ? previous.startedAt : new Date().toISOString();

  let manifest = {
    key: FULL_META_KEY,
    version: FULL_DICTIONARY_VERSION,
    status: "installing",
    source: "ECDICT full",
    sourceUrl: FULL_DICTIONARY_URL,
    sourceRows: resumeSourceRows,
    importedCount: resumeImported,
    startedAt,
    updatedAt: new Date().toISOString(),
    error: ""
  };
  await putMeta(manifest);
  onProgress?.({ phase: "full", status: "downloading", ...manifest });

  try {
    const response = await fetch(FULL_DICTIONARY_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`完整词典下载失败（HTTP ${response.status}）。`);
    if (!response.body) throw new Error("当前浏览器不支持流式安装完整词典。请先使用内置常用词典。");

    const totalBytes = Number(response.headers.get("content-length")) || 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const now = new Date().toISOString();
    let receivedBytes = 0;
    let header = null;
    let termIndex = -1;
    let translationIndex = -1;
    let phoneticIndex = -1;
    let sourceRows = 0;
    let importedCount = resumeImported;
    let batch = [];

    const flush = async (forceMeta = false) => {
      if (batch.length === 0 && !forceMeta) return;
      manifest = {
        ...manifest,
        status: "installing",
        sourceRows,
        importedCount,
        receivedBytes,
        totalBytes,
        updatedAt: new Date().toISOString()
      };
      const records = batch;
      batch = [];
      await saveDictionaryBatch(records, manifest, { preserveCustom: true });
      onProgress?.({ phase: "full", ...manifest });
      await yieldToBrowser();
    };

    const onRow = async (row) => {
      if (!header) {
        header = row.map((cell) => cell.trim().toLowerCase());
        termIndex = header.indexOf("word");
        translationIndex = header.indexOf("translation");
        phoneticIndex = header.indexOf("phonetic");
        if (termIndex < 0 || translationIndex < 0) throw new Error("ECDICT 文件缺少必要字段。");
        return;
      }

      sourceRows += 1;
      if (sourceRows <= resumeSourceRows) return;

      const term = String(row[termIndex] || "").trim();
      const translation = String(row[translationIndex] || "").trim();
      const normalizedTerm = normalizeDictionaryTerm(term);
      if (term && normalizedTerm && !/[\u3400-\u9fff]/.test(term) && translation) {
        batch.push(dictionaryRecord(term, row[phoneticIndex] || "", translation, "ECDICT full", now));
        importedCount += 1;
      }

      if (batch.length >= FULL_BATCH_SIZE) await flush();
    };

    const parser = createCsvStreamParser(onRow);
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      await parser.write(decoder.decode(value, { stream: true }));
      if (totalBytes > 0 && sourceRows <= resumeSourceRows) {
        onProgress?.({ phase: "full", status: "downloading", sourceRows, importedCount, receivedBytes, totalBytes });
      }
    }
    await parser.write(decoder.decode());
    await parser.end();
    await flush(true);

    manifest = {
      ...manifest,
      status: "ready",
      sourceRows,
      importedCount,
      receivedBytes,
      totalBytes,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: ""
    };
    await putMeta(manifest);
    onProgress?.({ phase: "full", ...manifest });
    return manifest;
  } catch (error) {
    manifest = {
      ...manifest,
      status: "failed",
      error: error.message || "完整词典安装失败。",
      updatedAt: new Date().toISOString()
    };
    await putMeta(manifest).catch(() => undefined);
    onProgress?.({ phase: "full", ...manifest });
    throw error;
  }
}

function createCsvStreamParser(onRow) {
  let row = [];
  let cell = "";
  let inQuotes = false;
  let quotePending = false;
  let skipLf = false;

  async function emitRow() {
    row.push(cell);
    if (row.some((value) => value.trim())) await onRow(row);
    row = [];
    cell = "";
  }

  return {
    async write(chunk) {
      for (let index = 0; index < chunk.length; index += 1) {
        const char = chunk[index];
        if (skipLf) {
          skipLf = false;
          if (char === "\n") continue;
        }

        if (quotePending) {
          quotePending = false;
          if (char === '"') {
            cell += '"';
            continue;
          }
          inQuotes = false;
        }

        if (inQuotes) {
          if (char === '"') quotePending = true;
          else cell += char;
          continue;
        }

        if (char === '"') {
          inQuotes = true;
        } else if (char === ",") {
          row.push(cell);
          cell = "";
        } else if (char === "\n" || char === "\r") {
          await emitRow();
          if (char === "\r") skipLf = true;
        } else {
          cell += char;
        }
      }
    },
    async end() {
      if (quotePending) inQuotes = false;
      if (cell || row.length) await emitRow();
    }
  };
}

export async function lookupDictionary(text) {
  const input = String(text || "").trim();
  if (!input) return { status: "empty", input, candidates: [] };
  if (/[\u3400-\u9fff]/.test(input)) {
    return { status: "unsupported", input, candidates: [], message: "当前只支持英文查中文。" };
  }

  const candidates = getLookupCandidates(input);
  for (const candidate of candidates) {
    const raw = await getDictionaryEntry(candidate);
    if (!raw) continue;
    const entry = {
      term: raw.term || raw.normalizedTerm || candidate,
      normalizedTerm: raw.normalizedTerm || candidate,
      phonetic: raw.phonetic || "",
      definitions: splitDefinitions(raw.definitions),
      source: raw.source || "offline"
    };
    return { status: "found", input, matchedTerm: candidate, entry, candidates };
  }

  return { status: "missing", input, candidates, message: "离线词典中没有找到这个词。" };
}

export async function importDictionaryFile(file, onProgress) {
  const text = await file.text();
  const trimmed = text.trim();
  if (!trimmed) throw new Error("词典文件是空的。");

  let entries;
  if (file.name.toLowerCase().endsWith(".json") || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const raw = JSON.parse(trimmed);
    const rows = Array.isArray(raw) ? raw : raw.entries;
    if (!Array.isArray(rows)) throw new Error("JSON 词典必须是数组，或包含 entries 数组。");
    entries = rows.map((row) => ({
      term: row.term ?? row.word ?? row.english ?? row.en,
      phonetic: row.phonetic ?? row.pronunciation ?? row.ipa,
      definition: row.definition ?? row.definitions ?? row.translation ?? row.chinese ?? row.zh
    }));
  } else {
    const delimiter = file.name.toLowerCase().endsWith(".tsv") || trimmed.includes("\t") ? "\t" : ",";
    const rows = parseDelimitedRows(trimmed, delimiter);
    const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) || [];
    const hasHeader = header.some((cell) => ["word", "term", "english", "en"].includes(cell));
    const termIndex = hasHeader ? findHeaderIndex(header, ["word", "term", "english", "en"]) : 0;
    const definitionIndex = hasHeader ? findHeaderIndex(header, ["definition", "definitions", "translation", "chinese", "zh"]) : 1;
    const phoneticIndex = hasHeader ? findHeaderIndex(header, ["phonetic", "pronunciation", "ipa"]) : -1;
    if (termIndex < 0 || definitionIndex < 0) throw new Error("词典需要英文词条和中文释义两列。");
    entries = (hasHeader ? rows.slice(1) : rows).map((row) => ({
      term: row[termIndex],
      definition: row[definitionIndex],
      phonetic: phoneticIndex >= 0 ? row[phoneticIndex] : ""
    }));
  }

  const now = new Date().toISOString();
  const records = entries
    .map((entry) => {
      const term = String(entry.term || "").trim();
      const definitions = splitDefinitions(entry.definition);
      if (!term || !normalizeDictionaryTerm(term) || /[\u3400-\u9fff]/.test(term) || definitions.length === 0) return null;
      return dictionaryRecord(term, entry.phonetic, definitions, file.name, now);
    })
    .filter(Boolean);
  if (records.length === 0) throw new Error("没有找到有效词条。");

  for (let start = 0; start < records.length; start += CORE_BATCH_SIZE) {
    await saveDictionaryBatch(records.slice(start, start + CORE_BATCH_SIZE), null);
    onProgress?.({ importedCount: Math.min(start + CORE_BATCH_SIZE, records.length), expectedCount: records.length });
    await yieldToBrowser();
  }
  return records.length;
}

function findHeaderIndex(header, names) {
  return header.findIndex((cell) => names.includes(cell));
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

function getLookupCandidates(text) {
  const normalized = normalizeDictionaryTerm(text).replace(/[’]/g, "'");
  if (!normalized) return [];
  const words = normalized.match(/[a-z]+(?:'[a-z]+)?/g) || [];
  const candidates = [normalized];
  for (const word of words) candidates.push(word, ...getEnglishBaseCandidates(word));
  return [...new Set(candidates.filter(Boolean))];
}

function getEnglishBaseCandidates(word) {
  const candidates = [];
  if (word.endsWith("'s")) candidates.push(word.slice(0, -2));

  if (word.length > 3) {
    if (word.endsWith("ies") && word.length > 4) candidates.push(`${word.slice(0, -3)}y`);
    if (word.endsWith("ves") && word.length > 4) candidates.push(`${word.slice(0, -3)}f`, `${word.slice(0, -3)}fe`);
    if (word.endsWith("es")) candidates.push(word.slice(0, -2));
    if (word.endsWith("s") && !word.endsWith("ss")) candidates.push(word.slice(0, -1));
  }

  if (word.endsWith("ying") && word.length > 5) candidates.push(`${word.slice(0, -4)}ie`);
  if (word.endsWith("ing") && word.length > 5) {
    const stem = word.slice(0, -3);
    candidates.push(stem, `${stem}e`, undoubleFinalConsonant(stem));
  }
  if (word.endsWith("ied") && word.length > 4) candidates.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("ed") && word.length > 4) {
    const stem = word.slice(0, -2);
    candidates.push(stem, `${stem}e`, undoubleFinalConsonant(stem));
  }
  if (word.endsWith("iest") && word.length > 5) candidates.push(`${word.slice(0, -4)}y`);
  if (word.endsWith("ier") && word.length > 4) candidates.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("est") && word.length > 5) {
    const stem = word.slice(0, -3);
    candidates.push(stem, `${stem}e`, undoubleFinalConsonant(stem));
  }
  if (word.endsWith("er") && word.length > 4) {
    const stem = word.slice(0, -2);
    candidates.push(stem, `${stem}e`, undoubleFinalConsonant(stem));
  }

  return candidates;
}

function undoubleFinalConsonant(stem) {
  if (stem.length < 3) return "";
  const last = stem.at(-1);
  const previous = stem.at(-2);
  if (last !== previous || !/[bcdfghjklmnpqrstvwxyz]/.test(last)) return "";
  return stem.slice(0, -1);
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
