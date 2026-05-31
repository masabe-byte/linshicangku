import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_ECDICT_CSV = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv";
const DEFAULT_HF_REPO_ID = "masabe/english-pronunciation-audio";
const FIELDS = ["word", "phonetic", "definition", "translation", "pos", "collins", "oxford", "tag", "bnc", "frq", "exchange", "detail", "audio"];

function envNumber(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeWord(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

function shardPath(word) {
  const clean = normalizeWord(word);
  const first = /^[a-z]/.test(clean[0] || "") ? clean[0] : "_";
  const second = /^[a-z]/.test(clean[1] || "") ? clean.slice(0, 2) : `${first}_`;
  return `dict/${first}/${second}.json`;
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function splitLines(text) {
  return String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
}

async function readText(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to fetch ECDICT CSV: ${response.status} ${response.statusText}`);
    return response.text();
  }
  return fs.readFile(source, "utf8");
}

function compactEntry(row) {
  const word = normalizeWord(row.word);
  if (!/^[a-z][a-z' -]{0,60}$/.test(word)) return null;
  const translation = String(row.translation || "").trim();
  const definition = String(row.definition || "").trim();
  if (!translation && !definition) return null;
  return {
    word,
    phonetic: String(row.phonetic || "").trim(),
    translation,
    definition,
    pos: String(row.pos || "").trim(),
    collins: Number(row.collins || 0) || 0,
    oxford: Number(row.oxford || 0) || 0,
    tag: String(row.tag || "").trim(),
    bnc: Number(row.bnc || 0) || 0,
    frq: Number(row.frq || 0) || 0,
    exchange: String(row.exchange || "").trim(),
  };
}

function csvToShards(csvText, { limit = 0 } = {}) {
  const lines = splitLines(csvText);
  const header = parseCsvLine(lines.shift() || "");
  const fieldIndexes = FIELDS.map((field) => header.indexOf(field));
  const shards = new Map();
  let total = 0;
  let kept = 0;

  for (const line of lines) {
    if (limit && kept >= limit) break;
    total += 1;
    const cells = parseCsvLine(line);
    const row = {};
    for (let index = 0; index < FIELDS.length; index += 1) {
      row[FIELDS[index]] = cells[fieldIndexes[index]] || "";
    }
    const entry = compactEntry(row);
    if (!entry) continue;
    const shard = shardPath(entry.word);
    const bucket = shards.get(shard) || {};
    bucket[entry.word] = entry;
    shards.set(shard, bucket);
    kept += 1;
  }

  return { shards, total, kept };
}

async function writeShards(shards, outDir) {
  for (const [relativePath, entries] of shards.entries()) {
    const file = path.join(outDir, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(entries), "utf8");
  }
}

function runHfUpload(repoId, folder) {
  const command = process.platform === "win32" ? "hf.exe" : "hf";
  const result = spawnSync(command, ["upload", repoId, folder, ".", "--repo-type=dataset"], {
    env: process.env,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "hf upload failed").trim());
  }
  return result.stdout;
}

async function main() {
  const repoId = process.env.HF_REPO_ID || DEFAULT_HF_REPO_ID;
  const sourceCsv = process.env.ECDICT_SOURCE_CSV || DEFAULT_ECDICT_CSV;
  const dryRun = process.env.DRY_RUN === "1";
  const limit = envNumber("ECDICT_LIMIT", 0);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "soil-ecdict-hf-"));

  if (!dryRun && !process.env.HF_TOKEN) throw new Error("HF_TOKEN is required for upload");

  try {
    const csv = await readText(sourceCsv);
    const result = csvToShards(csv, { limit });
    await writeShards(result.shards, tempDir);
    const sample = [...result.shards.entries()].slice(0, 5).map(([file, entries]) => ({ file, count: Object.keys(entries).length }));
    console.log(JSON.stringify({ repoId, sourceCsv, dryRun, limit, sourceRowsSeen: result.total, entriesKept: result.kept, shardCount: result.shards.size, sample }, null, 2));
    if (!dryRun) runHfUpload(repoId, tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
