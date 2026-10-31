/**
 * Posts a tick at a fixed interval. A browser slows the timers of a hidden page to about one call each minute, and a
 * worker timer keeps its interval, so a reminder in a hidden tab stays on time.
 *
 * Messages in: `{ intervalMs: number }` starts or restarts the ticks. Messages out: `'tick'`.
 */
let timer: ReturnType<typeof setInterval> | undefined

globalThis.addEventListener('message', (event: MessageEvent<{ intervalMs: number }>) => {
  if (timer)
    clearInterval(timer)
  timer = setInterval(() => globalThis.postMessage('tick'), event.data.intervalMs)
})
