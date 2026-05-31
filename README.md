# Pronunciation Audio Importer

Temporary uploader for the personal Hugging Face Dataset:

```text
masabe/english-pronunciation-audio
```

It downloads pronunciation MP3 files from the configured source JSON on a GitHub Actions runner and uploads them to the dataset as:

```text
words/<first-letter>/<word>.mp3
```

Old flat files under `words/<word>.mp3` can remain in the dataset. The browser extension tries the sharded path first, then the old flat path for backward compatibility.

## GitHub Secret

Add this repository secret before running the workflow:

```text
HF_TOKEN=hf_...
```

## Run

Open the Actions tab and run **Pronunciation Hugging Face Import**.

Suggested first run:

```text
start_offset: 0
batch_size: 500
max_batches: 40
import_mode: missing
dry_run: 0
```

That scans from the start, skips files already present in Hugging Face, and uploads up to 20,000 missing words in one workflow run. The importer uses `ultimate.json`, so one word can try multiple candidate audio URLs before it gives up.

If the workflow reaches the 60 minute timeout, start the next run with the last printed `nextOffset`.

Continue later with:

```text
start_offset: <last nextOffset>
batch_size: 500
max_batches: 40
import_mode: missing
dry_run: 0
```

`import_mode: range` is still available if you want to process a raw offset range without skipping existing files.

The generated extension base URL is:

```text
https://huggingface.co/datasets/masabe/english-pronunciation-audio/resolve/main
```

## ECDICT Import

The temporary repository also uploads ECDICT shards for the translation extension dictionary panel.

Open Actions and run **ECDICT Hugging Face Import**:

```text
source_csv: https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
limit: 0
dry_run: 0
```

The importer writes small two-letter shards:

```text
dict/a/ad.json
dict/h/hi.json
dict/c/co.json
```

The extension can fetch only the shard needed for the selected word.
