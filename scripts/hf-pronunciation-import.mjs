import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_SOURCE_JSON = "https://raw.githubusercontent.com/thousandlemons/English-words-pronunciation-mp3-audio-download/master/data.json";
const DEFAULT_HF_REPO_ID = "masabe/english-pronunciation-audio";

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

function isImportableWord(value) {
  return /^[a-z][a-z'-]{1,39}$/.test(value);
}

function getFirstAudioUrl(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item) => typeof item === "string") || "";
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const url = getFirstAudioUrl(item);
      if (url) return url;
    }
  }
  return "";
}

async function readJson(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to fetch source JSON: ${response.status} ${response.statusText}`);
    return response.json();
  }
  return JSON.parse(await fs.readFile(source, "utf8"));
}

function toEntries(json) {
  if (Array.isArray(json)) {
    return json
      .map((item) => [normalizeWord(item?.word || item?.text || item?.name), getFirstAudioUrl(item?.url || item?.audio || item?.mp3 || item)])
      .filter(([word, url]) => isImportableWord(word) && /^https?:\/\//i.test(url));
  }
  return Object.entries(json)
    .map(([word, value]) => [normalizeWord(word), getFirstAudioUrl(value)])
    .filter(([word, url]) => isImportableWord(word) && /^https?:\/\//i.test(url));
}

async function downloadAudio(url, file) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Soil-Pronunciation-HF-Importer/0.1",
    },
  });
  if (!response.ok) throw new Error(`Audio fetch failed: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 200) throw new Error("Audio file is too small");
  await fs.writeFile(file, bytes);
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
  const sourceJson = process.env.PRONUNCIATION_SOURCE_JSON || DEFAULT_SOURCE_JSON;
  const offset = envNumber("IMPORT_OFFSET", 0);
  const limit = envNumber("IMPORT_LIMIT", 500);
  const dryRun = process.env.DRY_RUN === "1";
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "soil-pronunciation-hf-"));
  const wordsDir = path.join(tempDir, "words");

  if (!dryRun && !process.env.HF_TOKEN) {
    throw new Error("HF_TOKEN is required for upload");
  }

  try {
    await fs.mkdir(wordsDir, { recursive: true });
    const entries = toEntries(await readJson(sourceJson));
    const batch = entries.slice(offset, offset + limit);
    let prepared = 0;
    let failed = 0;

    console.log(JSON.stringify({ repoId, sourceJson, total: entries.length, offset, limit, batch: batch.length, dryRun }, null, 2));

    for (const [word, url] of batch) {
      const file = path.join(wordsDir, `${encodeURIComponent(word)}.mp3`);
      try {
        if (!dryRun) await downloadAudio(url, file);
        prepared += 1;
        console.log(`OK ${word} -> words/${encodeURIComponent(word)}.mp3`);
      } catch (error) {
        failed += 1;
        console.warn(`FAIL ${word}: ${error.message}`);
      }
    }

    if (!dryRun && prepared > 0) {
      runHfUpload(repoId, tempDir);
    }

    console.log(JSON.stringify({ prepared, failed, uploaded: dryRun ? 0 : prepared, nextOffset: offset + batch.length }, null, 2));
    if (failed && process.env.FAIL_ON_ERROR === "1") process.exitCode = 1;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
