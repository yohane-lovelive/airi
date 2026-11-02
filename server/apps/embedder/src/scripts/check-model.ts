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

// Topic labels: the API embeds them with the query prefix, which separated these groups best. The client maps the
// cosine from 0.70 to 0.90 onto the scale of character pairs. These pairs show where the cosines fall.
const labelPairs: [string, string, 'same' | 'near' | 'other'][] = [
  ['ラーメン', 'ラーメン屋', 'same'],
  ['ラーメン', '麺類', 'same'],
  ['大阪旅行', '週末の旅行', 'same'],
  ['猫', 'ペットの猫', 'same'],
  ['LoL のランク戦', 'League of Legends', 'same'],
  ['ラーメン', '夕ご飯', 'near'],
  ['大阪旅行', '新幹線', 'near'],
  ['猫', '犬', 'near'],
  ['LoL のランク戦', 'ゲームの練習', 'near'],
  ['ラーメン', '大阪旅行', 'other'],
  ['猫', 'LoL のランク戦', 'other'],
  ['天気', 'プログラミング', 'other'],
  ['仕事の締め切り', 'ラーメン', 'other'],
  ['映画', '猫', 'other'],
]
const labels = [...new Set(labelPairs.flatMap(([left, right]) => [left, right]))]
const vectors = new Map((await model.embed(labels, 'query')).map((vector, index) => [labels[index], vector]))
for (const kind of ['same', 'near', 'other'] as const) {
  const scores = labelPairs.filter(pair => pair[2] === kind).map(([left, right]) => vectors.get(left)!.reduce((sum, value, at) => sum + value * vectors.get(right)![at], 0))
  process.stdout.write(`${kind}: ${scores.map(score => score.toFixed(3)).join(', ')} (min ${Math.min(...scores).toFixed(3)}, max ${Math.max(...scores).toFixed(3)})\n`)
}
