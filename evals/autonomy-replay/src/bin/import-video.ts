import process from 'node:process'

import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'

import { importVideo } from '../import-video'
import { defaultRecordingsDirectory } from '../recording'

/**
 * Imports a play video as a recording for the replay.
 *
 *   pnpm -F @proj-airi/evals-autonomy-replay import-video <video> [--recordings <folder>] [--id <name>] [--app <name>]
 *
 * Call stack:
 *
 * main
 *   -> {@link importVideo}
 *     -> ffmpeg (frames as JPEG files)
 *     -> thumbnails, `frames.jsonl`, `manifest.json`
 */
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      recordings: { type: 'string' },
      id: { type: 'string' },
      app: { type: 'string' },
    },
  })
  const [video] = positionals
  if (!video)
    throw new Error('Name the video file: import-video <video> [--recordings <folder>] [--id <name>] [--app <name>]')

  const result = await importVideo({
    video,
    // The same precedence as the evaluation: the named folder, then the env value, then the folder of the app.
    recordings: values.recordings || process.env.AUTONOMY_REPLAY_RECORDINGS || defaultRecordingsDirectory(),
    ...(values.id ? { id: values.id } : {}),
    ...(values.app ? { app: values.app } : {}),
  })
  console.info(`Imported ${result.frames} frames to ${result.directory}`)
}

main().catch((error) => {
  console.error(errorMessageFrom(error) ?? 'The import failed.')
  process.exitCode = 1
})
