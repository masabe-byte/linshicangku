import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_SOURCE_JSON = "https://raw.githubusercontent.com/thousandlemons/English-words-pronunciation-mp3-audio-download/master/ultimate.json";
const DEFAULT_HF_REPO_ID = "masabe/english-pronunciation-audio";
const HF_TREE_PAGE_SIZE = 1000;
const MIN_AUDIO_BYTES = 200;
const DEFAULT_UPLOAD_RETRIES = 4;
const DEFAULT_UPLOAD_DELAY_MS = 3000;

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

function wordPath(word) {
  const encoded = encodeURIComponent(word);
  const bucket = /^[a-z]/.test(word) ? word[0] : "_";
  return `words/${bucket}/${encoded}.mp3`;
}

function legacyWordPath(word) {
  return `words/${encodeURIComponent(word)}.mp3`;
}

function collectAudioUrls(value, output = []) {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAudioUrls(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectAudioUrls(item, output);
  }
  return output;
}

function uniqueUrls(urls) {
  return [...new Set(urls.map((url) => String(url || "").trim()).filter((url) => /^https?:\/\//i.test(url)))];
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
  const rawEntries = Array.isArray(json)
    ? json.map((item) => [item?.word || item?.text || item?.name, item?.url || item?.audio || item?.mp3 || item])
    : Object.entries(json);

  return rawEntries
    .map(([word, value]) => [normalizeWord(word), uniqueUrls(collectAudioUrls(value))])
    .filter(([word, urls]) => isImportableWord(word) && urls.length > 0);
}

async function downloadAudio(url, file) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 Soil-Pronunciation-HF-Importer/0.2",
      "Accept": "audio/mpeg,audio/*,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < MIN_AUDIO_BYTES) throw new Error(`too_small_${bytes.byteLength}`);
  await fs.writeFile(file, bytes);
  return bytes.byteLength;
}

async function downloadFirstAvailableAudio(urls, file) {
  const errors = [];
  for (const url of urls) {
    try {
      const bytes = await downloadAudio(url, file);
      return { ok: true, url, bytes, attempts: errors.length + 1 };
    } catch (error) {
      errors.push(`${url} -> ${error.message}`);
    }
  }
  return { ok: false, attempts: errors.length, error: errors.slice(0, 4).join(" | ") };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterMs(error) {
  const message = String(error?.message || "");
  const retryAfter = message.match(/Retry after\s+(\d+)\s+seconds/i);
  if (retryAfter) return (Number.parseInt(retryAfter[1], 10) + 5) * 1000;
  if (/429 Too Many Requests/i.test(message)) return 180000;
  if (/504 Gateway Time-out|maximum time in concurrency queue reached/i.test(message)) return 60000;
  return 0;
}

async function runHfUploadWithRetry(repoId, folder, { retries, delayMs }) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return runHfUpload(repoId, folder);
    } catch (error) {
      lastError = error;
      const retryAfterMs = getRetryAfterMs(error);
      if (!retryAfterMs || attempt >= retries) throw error;
      const waitMs = Math.max(retryAfterMs, delayMs);
      console.warn(`HF upload throttled/queued. Retry ${attempt + 1}/${retries} after ${Math.ceil(waitMs / 1000)}s.`);
      await sleep(waitMs);
    }
  }
  throw lastError || new Error("hf upload failed");
}

async function fetchExistingFiles(repoId) {
  const existing = new Set();
  let url = `https://huggingface.co/api/datasets/${repoId}/tree/main/words?recursive=true&limit=${HF_TREE_PAGE_SIZE}`;
  for (let page = 0; page < 500 && url; page += 1) {
    const response = await fetch(url, {
      headers: process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {},
    });
    if (response.status === 404) return existing;
    if (!response.ok) throw new Error(`Failed to list HF files: ${response.status} ${response.statusText}`);
    const items = await response.json();
    for (const item of items) {
      if (item?.type === "file" && item.path?.endsWith(".mp3")) existing.add(item.path);
    }
    const link = response.headers.get("link") || "";
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : "";
  }
  return existing;
}

async function prepareBatch(entries, wordsDir, dryRun) {
  let prepared = 0;
  let failed = 0;
  let skipped = 0;
  let attemptedUrls = 0;
  const failures = [];

  await fs.rm(wordsDir, { recursive: true, force: true });
  await fs.mkdir(wordsDir, { recursive: true });

  for (const entry of entries) {
    const [word, urls] = entry;
    const relativePath = wordPath(word);
    const file = path.join(wordsDir, relativePath.replace(/^words\//, ""));
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (dryRun) {
        prepared += 1;
        attemptedUrls += Math.min(urls.length, 1);
        console.log(`OK ${word} -> ${relativePath} (dry-run, ${urls.length} candidate urls)`);
        continue;
      }

      const result = await downloadFirstAvailableAudio(urls, file);
      attemptedUrls += result.attempts;
      if (!result.ok) throw new Error(result.error || "all_urls_failed");
      prepared += 1;
      console.log(`OK ${word} -> ${relativePath} (${result.bytes} bytes, url ${result.attempts}/${urls.length})`);
    } catch (error) {
      failed += 1;
      failures.push({ word, urls: urls.length, error: error.message });
      console.warn(`FAIL ${word}: ${error.message}`);
    }
  }

  return { prepared, failed, skipped, attemptedUrls, failures };
}

function selectBatch(entries, existing, mode, offset, limit) {
  if (mode === "missing") {
    const batch = [];
    let scanned = 0;
    for (let index = offset; index < entries.length && batch.length < limit; index += 1) {
      const [word] = entries[index];
      scanned += 1;
      if (!existing.has(wordPath(word)) && !existing.has(legacyWordPath(word))) batch.push(entries[index]);
    }
    return { batch, scanned };
  }
  const batch = entries.slice(offset, offset + limit);
  return { batch, scanned: batch.length };
}

async function main() {
  const repoId = process.env.HF_REPO_ID || DEFAULT_HF_REPO_ID;
  const sourceJson = process.env.PRONUNCIATION_SOURCE_JSON || DEFAULT_SOURCE_JSON;
  const mode = String(process.env.IMPORT_MODE || "missing").toLowerCase();
  const startOffset = envNumber("IMPORT_OFFSET", 0);
  const batchSize = envNumber("IMPORT_BATCH_SIZE", envNumber("IMPORT_LIMIT", 500));
  const maxBatches = Math.max(1, envNumber("IMPORT_MAX_BATCHES", 1));
  const uploadRetries = Math.max(0, envNumber("HF_UPLOAD_RETRIES", DEFAULT_UPLOAD_RETRIES));
  const uploadDelayMs = Math.max(0, envNumber("HF_UPLOAD_DELAY_MS", DEFAULT_UPLOAD_DELAY_MS));
  const dryRun = process.env.DRY_RUN === "1";
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "soil-pronunciation-hf-"));
  const wordsDir = path.join(tempDir, "words");

  if (!["range", "missing"].includes(mode)) throw new Error("IMPORT_MODE must be range or missing");
  if (!dryRun && !process.env.HF_TOKEN) throw new Error("HF_TOKEN is required for upload");

  try {
    const entries = toEntries(await readJson(sourceJson));
    const existing = await fetchExistingFiles(repoId);
    let totalPrepared = 0;
    let totalFailed = 0;
    let totalScanned = 0;
    let totalAttemptedUrls = 0;
    let batchesRun = 0;
    let offset = startOffset;

    console.log(JSON.stringify({ repoId, sourceJson, sourceEntries: entries.length, existingFiles: existing.size, mode, startOffset, batchSize, maxBatches, uploadRetries, uploadDelayMs, dryRun }, null, 2));

    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      if (offset >= entries.length) break;
      const selected = selectBatch(entries, existing, mode, offset, batchSize);
      if (!selected.batch.length) break;
      console.log(`\n=== Batch ${batchIndex + 1}/${maxBatches}: offset ${offset}, selected ${selected.batch.length}, scanned ${selected.scanned} ===`);

      const result = await prepareBatch(selected.batch, wordsDir, dryRun);
      totalPrepared += result.prepared;
      totalFailed += result.failed;
      totalScanned += selected.scanned;
      totalAttemptedUrls += result.attemptedUrls;
      batchesRun += 1;

      if (!dryRun && result.prepared > 0) {
        await runHfUploadWithRetry(repoId, tempDir, { retries: uploadRetries, delayMs: uploadDelayMs });
        for (const [word] of selected.batch) {
          if (!result.failures.some((failure) => failure.word === word)) {
            existing.add(wordPath(word));
          }
        }
        if (uploadDelayMs > 0 && batchIndex < maxBatches - 1) {
          console.log(`Waiting ${Math.ceil(uploadDelayMs / 1000)}s before next HF upload batch.`);
          await sleep(uploadDelayMs);
        }
      }

      const report = {
        batch: batchIndex + 1,
        offset,
        selected: selected.batch.length,
        scanned: selected.scanned,
        prepared: result.prepared,
        failed: result.failed,
        attemptedUrls: result.attemptedUrls,
        nextOffset: offset + selected.scanned,
        failureSample: result.failures.slice(0, 10),
      };
      console.log(JSON.stringify(report, null, 2));
      offset += selected.scanned;
    }

    console.log(JSON.stringify({
      batchesRun,
      scanned: totalScanned,
      prepared: totalPrepared,
      failed: totalFailed,
      uploaded: dryRun ? 0 : totalPrepared,
      attemptedUrls: totalAttemptedUrls,
      nextOffset: offset,
    }, null, 2));
    if (totalFailed && process.env.FAIL_ON_ERROR === "1") process.exitCode = 1;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
