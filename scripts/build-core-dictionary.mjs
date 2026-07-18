#!/usr/bin/env node

import fs from "node:fs";

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  console.error("Usage: node scripts/build-core-dictionary.mjs <ecdict.csv> <output.json>");
  process.exit(1);
}

const MAX_ENTRIES = 40000;
const rows = [];
let header = null;

function normalizeWord(value) {
  return String(value || "").trim().toLowerCase();
}

function numericRank(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

function cleanTranslation(value) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[网络\]/.test(line))
    .slice(0, 6)
    .join("\n");
}

function acceptRow(row) {
  if (!header) {
    header = new Map(row.map((value, index) => [value.trim().toLowerCase(), index]));
    return;
  }

  const get = (name) => row[header.get(name)] || "";
  const word = normalizeWord(get("word"));
  const translation = cleanTranslation(get("translation"));
  if (!/^[a-z][a-z'-]{1,39}$/.test(word) || !translation || !/[\u3400-\u9fff]/.test(translation)) return;

  const bnc = numericRank(get("bnc"));
  const frq = numericRank(get("frq"));
  const collins = Number(get("collins")) || 0;
  const oxford = Number(get("oxford")) || 0;
  const tags = get("tag").trim();
  const corpusRank = Math.min(bnc, frq);
  if (!Number.isFinite(corpusRank) && collins === 0 && oxford === 0 && !tags) return;

  let score = corpusRank;
  if (oxford) score = Math.min(score, 3500);
  if (collins) score = Math.min(score, Math.max(500, 7000 - collins * 1000));
  if (tags) score = Math.min(score, 18000);

  rows.push([
    word,
    String(get("phonetic") || "").trim(),
    translation,
    Number.isFinite(score) ? score : 999999
  ]);
}

function createCsvParser(onRow) {
  let row = [];
  let cell = "";
  let inQuotes = false;
  let pendingQuote = false;
  let pendingCr = false;

  function emitRow() {
    row.push(cell);
    if (row.some((value) => value.trim())) onRow(row);
    row = [];
    cell = "";
  }

  return {
    write(chunk) {
      for (let index = 0; index < chunk.length; index += 1) {
        const char = chunk[index];

        if (pendingCr) {
          pendingCr = false;
          if (char === "\n") continue;
        }

        if (pendingQuote) {
          pendingQuote = false;
          if (char === '"') {
            cell += '"';
            continue;
          }
          inQuotes = false;
        }

        if (char === '"') {
          if (inQuotes) {
            const next = chunk[index + 1];
            if (next === '"') {
              cell += '"';
              index += 1;
            } else if (index === chunk.length - 1) {
              pendingQuote = true;
            } else {
              inQuotes = false;
            }
          } else {
            inQuotes = true;
          }
        } else if (char === "," && !inQuotes) {
          row.push(cell);
          cell = "";
        } else if ((char === "\n" || char === "\r") && !inQuotes) {
          emitRow();
          if (char === "\r") pendingCr = true;
        } else {
          cell += char;
        }
      }
    },
    end() {
      if (pendingQuote) inQuotes = false;
      if (cell || row.length) emitRow();
    }
  };
}

const parser = createCsvParser(acceptRow);
const stream = fs.createReadStream(sourcePath, { encoding: "utf8" });
for await (const chunk of stream) parser.write(chunk);
parser.end();

rows.sort((a, b) => a[3] - b[3] || a[0].localeCompare(b[0]));
const unique = new Map();
for (const [word, phonetic, translation] of rows) {
  if (!unique.has(word)) unique.set(word, [word, phonetic, translation]);
  if (unique.size >= MAX_ENTRIES) break;
}

const payload = {
  version: "ecdict-core-2026-07",
  source: "ECDICT (MIT)",
  count: unique.size,
  entries: [...unique.values()]
};

fs.writeFileSync(outputPath, JSON.stringify(payload));
console.log(`Wrote ${payload.count} entries to ${outputPath}`);
