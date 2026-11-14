# @proj-airi/embedder-server

Turns text into vectors with [EmbeddingGemma 2](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX) for the memory search of the AIRI API. It loads the text path of the model only, with q8 weights of about 314 MB, and runs it on the CPU with Transformers.js and ONNX Runtime.

The design records are [the memory ADR](../../../docs/ai/adr/2026-11-02-long-term-memory-and-recall.md) and [the server ADR](../../docs/ai/adr/2026-11-02-memory-store-and-search.md).

## How to use it

`pnpm dev:backend` starts it with the rest of the stack. The first start downloads the model into the `embedder_models` volume, so the service is healthy only after the download.

To run it alone:

```sh
pnpm -F @proj-airi/embedder-server start
```

`POST /embed` takes `{ "texts": [...], "task": "query" | "document" | "similarity" }` and returns `{ "records": [{ "embedding": [...] }] }`. Each embedding has 256 dimensions and length 1, so a dot product is a cosine.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | The port. |
| `HOST` | `0.0.0.0` | The address to listen on. |
| `EMBEDDER_MODEL` | `onnx-community/embeddinggemma-2-ONNX` | The Hugging Face repository of the ONNX weights. |
| `EMBEDDER_DTYPE` | `q8` | The weights: `fp32`, `q8`, or `q4`. |
| `EMBEDDER_CACHE_DIR` | `./models` | The folder of the downloaded files. |

`pnpm -F @proj-airi/embedder-server check:model` loads the real model and ranks Japanese memories for questions that share no words with them. Run it after a change of the model or of Transformers.js.

## When to use it

- Use it with the API, which reads its address from `EMBEDDER_URL`.

## When not to use it

- Do not expose it outside the Docker network. It has no authentication.
- Do not use it for images or audio. It loads only the text path.
- Do not add it to a deployment that cannot spare about 1 GB of memory. Without it, the API answers the memory search with `503`, and the client recalls by character pairs.
