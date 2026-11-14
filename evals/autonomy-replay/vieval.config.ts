import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, loadEnv } from 'vieval'
import { chatModelFrom, ChatModels, chatProviderFrom, ChatProviders } from 'vieval/plugins/chat-models'

const rootDirectory = dirname(fileURLToPath(import.meta.url))
// The mode `test` reads `.env.test`, the file that the README names.
const env = loadEnv('test', rootDirectory, '')
const models = (env.AUTONOMY_REPLAY_MODELS || 'gpt-6-luna').split(',').map(model => model.trim()).filter(Boolean)
// NOTICE:
// The task checks the policy names, because this file cannot import them from `@proj-airi/stage-shared/perception`.
// Node loads this file and cannot resolve the TypeScript source that the package exports.
// Source: `exports` in `packages/stage-shared/package.json`.
// Remove this when stage-shared exports built files.
const APP_POLICY = 'fresh-keyframes'

// Each recording runs once for each model and each policy, so a shorter list makes a cheaper run.
const policies = (env.AUTONOMY_REPLAY_POLICIES || APP_POLICY).split(',').map(policy => policy.trim()).filter(Boolean)

export default defineConfig({
  env,
  plugins: [
    ChatProviders({
      providers: [
        // OpenCode Go serves an OpenAI-compatible endpoint, the same provider that the app uses.
        chatProviderFrom({
          id: 'opencode-go',
          inferenceExecutor: 'openai',
          optionalEnv: { baseURL: 'AUTONOMY_REPLAY_BASE_URL' },
          requiredEnv: { apiKey: 'AUTONOMY_REPLAY_API_KEY' },
        }),
      ],
    }),
    ChatModels({
      models: models.map(model => chatModelFrom({ provider: 'opencode-go', model })),
    }),
  ],
  projects: [
    {
      name: 'autonomy-replay',
      root: '.',
      include: ['evals/replay.eval.ts'],
      exclude: ['node_modules/**'],
      runMatrix: {
        override: {
          model: models,
          policy: policies,
        },
      },
    },
  ],
})
