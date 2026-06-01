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
  const fourth = clean.slice(0, 4).padEnd(4, "_").replace(/[^a-z]/g, "_");
  return `dict4/${first}/${fourth}.json`;
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

async function copyForBatch(files, sourceRoot, batchRoot) {
  await fs.rm(batchRoot, { recursive: true, force: true });
  for (const relativePath of files) {
    const source = path.join(sourceRoot, relativePath);
    const target = path.join(batchRoot, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

function groupShardFiles(shards, maxFiles) {
  const groups = new Map();
  for (const relativePath of shards.keys()) {
    const parts = relativePath.split("/");
    const group = parts[1] || "_";
    const files = groups.get(group) || [];
    files.push(relativePath);
    groups.set(group, files);
  }
  const batches = [];
  for (const [group, files] of groups.entries()) {
    for (let index = 0; index < files.length; index += maxFiles) {
      batches.push({ group, files: files.slice(index, index + maxFiles) });
    }
  }
  return batches;
}

async function main() {
  const repoId = process.env.HF_REPO_ID || DEFAULT_HF_REPO_ID;
  const sourceCsv = process.env.ECDICT_SOURCE_CSV || DEFAULT_ECDICT_CSV;
  const dryRun = process.env.DRY_RUN === "1";
  const limit = envNumber("ECDICT_LIMIT", 0);
  const maxFilesPerUpload = Math.max(100, envNumber("ECDICT_MAX_FILES_PER_UPLOAD", 1500));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "soil-ecdict-hf-"));
  const batchDir = await fs.mkdtemp(path.join(os.tmpdir(), "soil-ecdict-hf-batch-"));

  if (!dryRun && !process.env.HF_TOKEN) throw new Error("HF_TOKEN is required for upload");

  try {
    const csv = await readText(sourceCsv);
    const result = csvToShards(csv, { limit });
    await writeShards(result.shards, tempDir);
    const batches = groupShardFiles(result.shards, maxFilesPerUpload);
    const sample = [...result.shards.entries()].slice(0, 5).map(([file, entries]) => ({ file, count: Object.keys(entries).length }));
    console.log(JSON.stringify({ repoId, sourceCsv, dryRun, limit, maxFilesPerUpload, sourceRowsSeen: result.total, entriesKept: result.kept, shardCount: result.shards.size, uploadBatches: batches.length, sample }, null, 2));
    if (!dryRun) {
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        console.log(`Uploading ECDICT batch ${index + 1}/${batches.length}: group ${batch.group}, files ${batch.files.length}`);
        await copyForBatch(batch.files, tempDir, batchDir);
        runHfUpload(repoId, batchDir);
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(batchDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
