import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FRAME_POLICY_NAMES } from '@proj-airi/stage-shared/perception'
import { parse, picklist } from 'valibot'
import { defineConfig, loadEnv } from 'vieval'
import { chatModelFrom, ChatModels, chatProviderFrom, ChatProviders } from 'vieval/plugins/chat-models'

const rootDirectory = dirname(fileURLToPath(import.meta.url))
const env = loadEnv('', rootDirectory, '')
const models = (env.AUTONOMY_REPLAY_MODELS ?? 'deepseek-v4.1-flash').split(',').map(model => model.trim()).filter(Boolean)
// Each recording runs once for each model and each policy, so a shorter list makes a cheaper run.
const policies = (env.AUTONOMY_REPLAY_POLICIES || FRAME_POLICY_NAMES.join(',')).split(',').map(policy => parse(picklist(FRAME_POLICY_NAMES), policy.trim()))

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
      include: ['evals/**/*.eval.ts'],
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
