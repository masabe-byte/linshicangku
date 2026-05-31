# Pronunciation Audio Importer

Temporary uploader for the personal Hugging Face Dataset:

```text
masabe/english-pronunciation-audio
```

It downloads pronunciation MP3 files from the configured source JSON on a GitHub Actions runner and uploads them to the dataset as:

```text
words/<word>.mp3
```

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
max_batches: 20
dry_run: 0
```

That processes up to 10,000 source entries in one workflow run. Then continue with:

```text
start_offset: 10000
batch_size: 500
max_batches: 20
dry_run: 0
```

Repeat with `20000`, `30000`, and so on until the script reports the final `nextOffset`.

The generated extension base URL is:

```text
https://huggingface.co/datasets/masabe/english-pronunciation-audio/resolve/main
```
