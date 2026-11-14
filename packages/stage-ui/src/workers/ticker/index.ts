/**
 * Calls a function at a fixed interval, also while the page is hidden.
 *
 * The ticks come from a worker, because a browser slows the timers of a hidden page to about one call each minute.
 * Where no `Worker` exists, for example in Node tests, the ticks come from `setInterval`.
 * Each instance owns one worker or one timer. `stop` ends it, and a later `start` makes a new one.
 */
export class Ticker {
  private worker?: Worker
  private timer?: ReturnType<typeof setInterval>

  constructor(private readonly intervalMs: number, private readonly onTick: () => void) {}

  /** Starts the ticks. A second call while the ticks run does nothing. */
  start() {
    if (this.worker || this.timer)
      return
    if (typeof Worker === 'undefined') {
      this.timer = setInterval(this.onTick, this.intervalMs)
      return
    }
    this.worker = new Worker(new URL('./ticker.worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', this.onTick)
    this.worker.postMessage({ intervalMs: this.intervalMs })
  }

  stop() {
    this.worker?.terminate()
    this.worker = undefined
    if (this.timer)
      clearInterval(this.timer)
    this.timer = undefined
  }
}
