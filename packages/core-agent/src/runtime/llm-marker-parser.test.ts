import { describe, expect, it } from 'vitest'

import { useLlmmarkerParser } from './llm-marker-parser'

/**
 * @example
 * const parser = useLlmmarkerParser({ onLiteral, onSpecial })
 */
describe('useLlmmarkerParser', () => {
  /**
   * @example
   * Plain model text is emitted as literal output.
   */
  it('parses pure literals', async () => {
    const collectedLiterals: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
    })

    await parser.consume('Hello, world!')
    await parser.end()

    expect(collectedLiterals.join('')).toBe('Hello, world!')
  })

  /**
   * @example
   * `<|...|>` markers are emitted as special output.
   */
  it('parses special markers separately from literals', async () => {
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
      onSpecial: (special) => {
        collectedSpecials.push(special)
      },
    })

    await parser.consume('Hello <|ACT|> world')
    await parser.end()

    expect(collectedLiterals.join('')).toBe('Hello  world')
    expect(collectedSpecials).toEqual(['<|ACT|>'])
  })

  /**
   * @example
   * Unfinished markers are withheld instead of leaking into literal text.
   */
  it('does not include unfinished special markers', async () => {
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
      onSpecial: (special) => {
        collectedSpecials.push(special)
      },
    })

    await parser.consume('<|unfinished')
    await parser.end()

    expect(collectedLiterals).toEqual([])
    expect(collectedSpecials).toEqual([])
  })

  // ROOT CAUSE:
  // The model sometimes closes a marker with `|` or `>` alone. The open marker then took the next marker, so a live check
  // lost the scene note and the topic label of most autonomous lines.
  it('closes a marker that the model closed wrongly at the line break or the next marker', async () => {
    const literals: string[] = []
    const specials: string[] = []
    const parser = useLlmmarkerParser({ onLiteral: literal => void literals.push(literal), onSpecial: special => void specials.push(special) })

    await parser.consume('見て！\n<|SCENE ボス戦、勇者HP 25|\n<|TOPIC ボス出現|>\n<|SCENE 作業中>')
    await parser.consume('\n<|TOPIC 見守り|><|SCENE 夜|<|NEXT wait|')
    await parser.end()

    expect(specials).toEqual(['<|SCENE ボス戦、勇者HP 25|>', '<|TOPIC ボス出現|>', '<|SCENE 作業中|>', '<|TOPIC 見守り|>', '<|SCENE 夜|>', '<|NEXT wait|>'])
    expect(literals.join('')).toBe('見て！\n\n\n\n')
  })

  it('keeps waiting for a correct marker that spans lines', async () => {
    const specials: string[] = []
    const parser = useLlmmarkerParser({ onSpecial: special => void specials.push(special) })

    await parser.consume('<|ACT {"emotion":\n"happy"}|> hi')
    await parser.end()

    expect(specials).toEqual(['<|ACT {"emotion":\n"happy"}|>'])
  })

  // A flush emits the held text and waits for its handler. Parsing continues after it.
  it('emits the held-back end of the text on flush, and keeps parsing after it', async () => {
    const collectedLiterals: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
    })

    await parser.consume('查曼谷和上海未来三天的天气。')
    await parser.flush()
    expect(collectedLiterals.join('')).toBe('查曼谷和上海未来三天的天气。')

    await parser.consume('第 1/3 步完成。')
    await parser.end()
    expect(collectedLiterals.join('')).toBe('查曼谷和上海未来三天的天气。第 1/3 步完成。')
  })
})
