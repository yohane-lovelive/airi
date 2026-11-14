import type { DecisionModelInput } from '../decision/gemini-decision'
import type { DecisionQuestion } from '../runtime/recipe'

/**
 * The settings of the screen gate: the first step that decides whether the character reacts to the screen.
 *
 * The gate asks the decision model one yes or no question about two frames. The chat model runs only after a yes, so
 * a calm screen costs no call of the chat model.
 */
export const SCREEN_GATE = {
  /** The gate looks at the screen this often, and compares the frame of this long ago with the current frame. */
  stepMs: 2_000,
  /**
   * The chance of yes from which the gate passes. On a recorded match, the gate trace of 2026-11-15 caught 66 of 67
   * important events at this value and passed 6 of 30 looks each minute. At 0.8 it caught 88%, and at 0.5 it passed
   * twice as many looks.
   */
  threshold: 0.7,
} as const

/**
 * The question of the screen gate.
 *
 * It asks only whether to react, and names no game and no detail of the screen. What happened is the work of the chat
 * model, which sees the frames at full size.
 * The words are the ones that the replay evaluation measured. Run the gate trace of `evals/autonomy-replay` again
 * after a change, because small changes of the words move the chances.
 */
export const SCREEN_GATE_QUESTION = {
  type: 'noul',
  instructions: '2 枚目（今）の画面で、1 枚目（2 秒前）の後に、隣で一緒に見ている人が思わず声をかけたくなる出来事が起きましたか。',
  criteria: {
    true: 'プレイヤーが敵を倒した、倒された、復活した。大きな通知や演出が出た。メニューや選択の画面に切り替わった。勝敗が決まった。',
    false: '同じ状況が続いているだけで、目立つ出来事はない。',
  },
} as const satisfies DecisionQuestion

/**
 * The material of one look of the screen gate: the frame of {@link SCREEN_GATE.stepMs} ago, then the current frame.
 * Both go at low resolution, which is enough to see that something happened.
 *
 * @param previous The earlier frame as JPEG base64, without a data URL prefix.
 * @param current The current frame as JPEG base64, without a data URL prefix.
 */
export function screenGateInput(previous: string, current: string): DecisionModelInput[] {
  return [
    { type: 'text', text: 'ゲームの画面を 2 枚渡します。1 枚目は 2 秒前、2 枚目が今です。\n' },
    { type: 'image', data: previous, mimeType: 'image/jpeg', resolution: 'low' },
    { type: 'image', data: current, mimeType: 'image/jpeg', resolution: 'low' },
  ]
}
