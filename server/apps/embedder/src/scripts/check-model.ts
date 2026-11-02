import process, { env } from 'node:process'

import { EmbeddingGemmaModel } from '../model'

/**
 * Loads the real model and ranks Japanese memories for questions that share no words with them. CI does not run it,
 * because it downloads the model. Run it by hand after a change of the model or of Transformers.js.
 */
const memories = [
  '好物はラーメンで、特に豚骨が好き。',
  '来週の土曜日に大阪へ旅行に行く予定。',
  '飼っている猫の名前はミケ。',
  'League of Legends ではミッドレーンを担当している。',
]
const questions = ['好きな食べ物は？', '週末はどこへ出かける？', 'ペットはいる？', 'ゲームで何のロールをやるの？']

const started = performance.now()
const model = await EmbeddingGemmaModel.load({
  modelId: env.EMBEDDER_MODEL ?? 'onnx-community/embeddinggemma-2-ONNX',
  dtype: 'q8',
  cacheDir: env.EMBEDDER_CACHE_DIR ?? './models',
})
process.stdout.write(`loaded in ${Math.round(performance.now() - started)} ms\n`)

const documents = await model.embed(memories, 'document')
let correct = 0
for (const [index, question] of questions.entries()) {
  const before = performance.now()
  const [query] = await model.embed([question], 'query')
  const scores = documents.map(document => document.reduce((sum, value, at) => sum + value * query[at], 0))
  const best = scores.indexOf(Math.max(...scores))
  correct += best === index ? 1 : 0
  process.stdout.write(`${question} -> ${memories[best]} (${scores.map(score => score.toFixed(3)).join(', ')}) ${Math.round(performance.now() - before)} ms\n`)
}
process.stdout.write(`dimensions ${documents[0].length}, correct ${correct}/${questions.length}\n`)
