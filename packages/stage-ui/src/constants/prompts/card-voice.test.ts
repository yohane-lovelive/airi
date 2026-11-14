import { describe, expect, it } from 'vitest'

import { CARD_VOICE_LIMITS, formatCardVoicePrompt } from './card-voice'

describe('formatCardVoicePrompt', () => {
  it('shows the greeting and the examples, with the names of the speakers', () => {
    const text = formatCardVoicePrompt({
      name: 'キズナアイ',
      greetings: ['はいどーもー！キズナアイです！', 'もう一つのあいさつ'],
      messageExample: [['{{user}}: ゲームしよう', '{{char}}: いいね、負けないよ！ Oh my god!']],
    })

    expect(text).toContain('Your usual greeting, as an example: "はいどーもー！キズナアイです！"')
    expect(text).not.toContain('もう一つのあいさつ')
    expect(text).toContain('they are not real history:\nOwner: ゲームしよう\nキズナアイ: いいね、負けないよ！ Oh my god!')
  })

  it('leaves out whole examples past the limit', () => {
    // With the name in place, this example is a few characters under the limit, so the next one does not fit.
    const long = `{{char}}: ${'あ'.repeat(CARD_VOICE_LIMITS.maxExampleChars - 5)}`
    const text = formatCardVoicePrompt({ name: 'ミク', messageExample: [[long], ['{{char}}: 二つめ']] })

    expect(text).toContain('ミク: あ')
    expect(text).not.toContain('二つめ')
  })

  it('gives nothing for a card without a greeting or an example', () => {
    expect(formatCardVoicePrompt({ name: 'AIRI', greetings: [' '], messageExample: [] })).toBe('')
  })
})
