const TAG_OPEN = '<|'
const TAG_CLOSE = '|>'
const ESCAPED_TAG_OPEN = '<{\'|\'}'
const ESCAPED_TAG_CLOSE = '{\'|\'}>'

/** A point in the text. The parser settles it once every literal before it is handled. */
interface MarkerFlush {
  settle: () => void
}

type MarkerToken
  = | { type: 'literal', value: string }
    | { type: 'special', value: string }
    | { type: 'flush', flush: MarkerFlush }

interface MarkerParserOptions {
  minLiteralEmitLength?: number
}

interface StreamController<T> {
  stream: ReadableStream<T>
  write: (value: T) => void
  close: () => void
  error: (err: unknown) => void
}

function createPushStream<T>(): StreamController<T> {
  let closed = false
  let controller: ReadableStreamDefaultController<T> | null = null

  const stream = new ReadableStream<T>({
    start(ctrl) {
      controller = ctrl
    },
    cancel() {
      closed = true
    },
  })

  return {
    stream,
    write(value) {
      if (!controller || closed)
        return
      controller.enqueue(value)
    },
    close() {
      if (!controller || closed)
        return
      closed = true
      controller.close()
    },
    error(err) {
      if (!controller || closed)
        return
      closed = true
      controller.error(err)
    },
  }
}

/**
 * The end of a marker that the model closed wrongly, for example `<|SCENE a room|` or `<|SCENE a room>` before a line
 * break or the next marker. A live check on 2026-11-04 saw both forms, and the open marker then took the next marker.
 *
 * Returns:
 * - The index where the broken marker ends, or -1 when the marker is not closed wrongly before a break.
 */
function brokenCloseIndex(buffer: string) {
  const lineBreak = buffer.indexOf('\n')
  const nextOpen = buffer.indexOf(TAG_OPEN, TAG_OPEN.length)
  const boundary = [lineBreak, nextOpen].filter(index => index >= 0).sort((a, b) => a - b)[0]
  if (boundary === undefined)
    return -1
  // A correct marker can span lines, so only a marker that ends with a broken close stops at the break.
  return /[|>]\s*$/.test(buffer.slice(TAG_OPEN.length, boundary)) ? boundary : -1
}

/** A broken marker with the closing that the marker handlers read. */
function closedMarker(text: string) {
  return `${text.trimEnd().replace(/[|>]$/, '')}${TAG_CLOSE}`
}

async function readStream<T>(stream: ReadableStream<T>, handler: (value: T) => Promise<void> | void) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done)
        break
      await handler(value as T)
    }
  }
  finally {
    reader.releaseLock()
  }
}

function createLlmMarkerParser(options?: MarkerParserOptions) {
  const minLiteralEmitLength = Math.max(1, options?.minLiteralEmitLength ?? 1)
  const tailLength = Math.max(TAG_OPEN.length - 1, ESCAPED_TAG_OPEN.length - 1)
  let buffer = ''
  let inTag = false

  return {
    async consume(textPart: string, onLiteral: (value: string) => Promise<void> | void, onSpecial: (value: string) => Promise<void> | void) {
      buffer += textPart
      buffer = buffer
        .replaceAll(ESCAPED_TAG_OPEN, TAG_OPEN)
        .replaceAll(ESCAPED_TAG_CLOSE, TAG_CLOSE)

      while (buffer.length > 0) {
        if (!inTag) {
          const openTagIndex = buffer.indexOf(TAG_OPEN)
          if (openTagIndex < 0) {
            if (buffer.length - tailLength >= minLiteralEmitLength) {
              const emit = buffer.slice(0, -tailLength)
              buffer = buffer.slice(-tailLength)
              await onLiteral(emit)
            }
            break
          }

          if (openTagIndex > 0) {
            const emit = buffer.slice(0, openTagIndex)
            buffer = buffer.slice(openTagIndex)
            await onLiteral(emit)
          }
          inTag = true
        }
        else {
          const closeTagIndex = buffer.indexOf(TAG_CLOSE)
          const brokenIndex = brokenCloseIndex(buffer)
          if (brokenIndex >= 0 && (closeTagIndex < 0 || brokenIndex < closeTagIndex)) {
            const marker = buffer.slice(0, brokenIndex)
            buffer = buffer.slice(brokenIndex)
            await onSpecial(closedMarker(marker))
            inTag = false
            continue
          }
          if (closeTagIndex < 0)
            break

          const emit = buffer.slice(0, closeTagIndex + TAG_CLOSE.length)
          buffer = buffer.slice(closeTagIndex + TAG_CLOSE.length)
          await onSpecial(emit)
          inTag = false
        }
      }
    },

    /**
     * Emits the text held back to find a marker, unless a marker is still open. At the end of the text, a marker that
     * ends with a broken close, for example `<|NEXT wait|`, is emitted as a marker. Other open text is dropped.
     */
    async flush(onLiteral: (value: string) => Promise<void> | void, onSpecial?: (value: string) => Promise<void> | void) {
      if (!inTag && buffer.length > 0) {
        await onLiteral(buffer)
        buffer = ''
      }
      else if (inTag && onSpecial && /[|>]\s*$/.test(buffer.slice(TAG_OPEN.length))) {
        await onSpecial(closedMarker(buffer))
        buffer = ''
        inTag = false
      }
    },
  }
}

function createLlmMarkerStream(input: ReadableStream<string | MarkerFlush>, options?: MarkerParserOptions) {
  const { stream, write, close, error } = createPushStream<MarkerToken>()
  const parser = createLlmMarkerParser(options)

  void readStream(input, async (chunk) => {
    if (typeof chunk !== 'string') {
      await parser.flush(async (literal) => {
        write({ type: 'literal', value: literal })
      })
      write({ type: 'flush', flush: chunk })
      return
    }
    await parser.consume(
      chunk,
      async (literal) => {
        if (!literal)
          return
        write({ type: 'literal', value: literal })
      },
      async (special) => {
        write({ type: 'special', value: special })
      },
    )
  })
    .then(async () => {
      await parser.flush(async (literal) => {
        if (!literal)
          return
        write({ type: 'literal', value: literal })
      }, async (special) => {
        write({ type: 'special', value: special })
      })
      close()
    })
    .catch((err) => {
      error(err)
    })

  return stream
}

/**
 * Creates a streaming parser for LLM responses with AIRI special markers.
 *
 * Use when:
 * - Handling streamed model output that may contain `<|...|>` markers.
 * - Literal text and special marker tokens need to be emitted separately.
 *
 * Expects:
 * - Callers feed chunks in order, call `flush()` where the text of a model step ends, and call `end()` once the model stream ends.
 *
 * Returns:
 * - A parser with `consume()`, `flush()`, and `end()` methods.
 */
export function useLlmmarkerParser(options: {
  onLiteral?: (literal: string) => void | Promise<void>
  onSpecial?: (special: string) => void | Promise<void>
  /**
   * Called when parsing ends with the full accumulated text.
   * Useful for final processing like categorization or filtering.
   */
  onEnd?: (fullText: string) => void | Promise<void>
  /**
   * The minimum length of text required to emit a literal part.
   * Useful for avoiding emitting literal parts too fast.
   */
  minLiteralEmitLength?: number
}) {
  let fullText = ''
  const { stream, write, close } = createPushStream<string | MarkerFlush>()

  const markerStream = createLlmMarkerStream(stream, { minLiteralEmitLength: options.minLiteralEmitLength })

  const processing = readStream(markerStream, async (token) => {
    if (token.type === 'literal')
      await options.onLiteral?.(token.value)
    else if (token.type === 'special')
      await options.onSpecial?.(token.value)
    else
      token.flush.settle()
  })

  return {
    /**
     * Consumes a chunk of text from the stream.
     *
     * @param textPart The chunk of text to consume.
     */
    async consume(textPart: string) {
      fullText += textPart
      write(textPart)
    },

    /**
     * Emits the text that the parser holds back to find a marker, and waits until every literal before this call is handled.
     *
     * Use when the text of a model step ends, for example at a tool call, so the call lands after that text.
     * After `end()`, it settles with the end of parsing.
     */
    flush() {
      return Promise.race([new Promise<void>(settle => write({ settle })), processing])
    },

    /**
     * Finalizes the parsing process.
     * Any remaining content in the buffer is flushed as a final literal part.
     */
    async end() {
      close()
      await processing
      await options.onEnd?.(fullText)
    },
  }
}
