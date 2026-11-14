#!/usr/bin/env node

import process, { env } from 'node:process'

import { useLogger } from '@guiiai/logg'
import { serve } from '@hono/node-server'
import { errorMessageFrom } from '@moeru/std'
import { integer, maxValue, minValue, object, optional, parse, picklist, pipe, string, transform } from 'valibot'

import { createEmbedderApp } from './app'
import { EmbeddingGemmaModel } from './model'

const EnvSchema = object({
  HOST: optional(string(), '0.0.0.0'),
  PORT: optional(pipe(string(), transform(Number), integer(), minValue(1), maxValue(65535)), '3000'),
  EMBEDDER_MODEL: optional(string(), 'onnx-community/embeddinggemma-2-ONNX'),
  EMBEDDER_DTYPE: optional(picklist(['fp32', 'q8', 'q4']), 'q8'),
  EMBEDDER_CACHE_DIR: optional(string(), './models'),
})

/** Loads the model, then listens. The first start downloads the model into the cache folder. */
async function main() {
  const logger = useLogger('embedder')
  const config = parse(EnvSchema, env)
  logger.log(`Loading ${config.EMBEDDER_MODEL} (${config.EMBEDDER_DTYPE})`)
  const model = await EmbeddingGemmaModel.load({ modelId: config.EMBEDDER_MODEL, dtype: config.EMBEDDER_DTYPE, cacheDir: config.EMBEDDER_CACHE_DIR })
  serve({ fetch: createEmbedderApp(model, logger).fetch, hostname: config.HOST, port: config.PORT })
  logger.log(`Listening on ${config.HOST}:${config.PORT}`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${errorMessageFrom(error) ?? 'Unknown embedder error'}\n`)
  process.exit(1)
})
