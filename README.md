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
offset: 0
limit: 500
dry_run: 0
```

Then continue with offsets `500`, `1000`, `1500`, and so on.

The generated extension base URL is:

```text
https://huggingface.co/datasets/masabe/english-pronunciation-audio/resolve/main
```
