import type { EmbeddingTask } from './prefix'

import { AutoConfig, AutoModel, AutoTokenizer, env } from '@huggingface/transformers'

import { truncateAndNormalize, withPrefix } from './prefix'

export interface EmbeddingModelOptions {
  /** The Hugging Face repository of the ONNX weights. */
  modelId: string
  /** The weights to load. `q8` is the text model of 314 MB. */
  dtype: 'fp32' | 'q8' | 'q4'
  /** The folder that keeps the downloaded files across restarts. */
  cacheDir: string
}

/** Turns texts into vectors. The app takes this shape, so tests give it a fake. */
export interface TextEmbedder {
  embed: (texts: readonly string[], task: EmbeddingTask) => Promise<number[][]>
}

type LoadedModel = Awaited<ReturnType<typeof AutoModel.from_pretrained>>
type LoadedTokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>

/**
 * EmbeddingGemma 2 with its text path only. The vision and audio encoders stay unloaded, which keeps the download
 * and the memory at the text model.
 *
 * Use when:
 * - The embedder service starts. It loads one model and keeps it for its life.
 *
 * Expects:
 * - One batch at a time. {@link embed} queues a batch behind the one that runs, so a large import cannot run two
 *   batches at once on the CPU.
 */
export class EmbeddingGemmaModel implements TextEmbedder {
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(private readonly model: LoadedModel, private readonly tokenizer: LoadedTokenizer) {}

  static async load(options: EmbeddingModelOptions) {
    env.cacheDir = options.cacheDir
    env.allowLocalModels = false
    const config = await AutoConfig.from_pretrained(options.modelId)
    // The ONNX model card loads the text path this way: without these configs the encoders are not loaded.
    Object.assign(config, { vision_config: null, audio_config: null })
    const model = await AutoModel.from_pretrained(options.modelId, { config, device: 'cpu', dtype: options.dtype })
    const tokenizer = await AutoTokenizer.from_pretrained(options.modelId)
    return new EmbeddingGemmaModel(model, tokenizer)
  }

  embed(texts: readonly string[], task: EmbeddingTask): Promise<number[][]> {
    const run = this.queue.catch(() => {}).then(() => this.run(texts, task))
    this.queue = run
    return run
  }

  private async run(texts: readonly string[], task: EmbeddingTask) {
    const inputs = await this.tokenizer(texts.map(text => withPrefix(text, task)), { padding: true, truncation: true })
    const { sentence_embedding: embedding } = await this.model(inputs)
    const [rows, width] = embedding.dims
    const values = embedding.data as Float32Array
    return Array.from({ length: rows }, (_, row) => truncateAndNormalize(values.subarray(row * width, (row + 1) * width)))
  }
}
