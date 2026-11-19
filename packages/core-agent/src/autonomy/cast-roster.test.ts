import { describe, expect, it } from 'vitest'

import { castFromRoster } from './cast-roster'

const ROSTER = 'Group 1: Kayle (alpha), Zilean (beta), Nami (gamma) Group 2: Miss Fortune (delta), T1 Gnar (moonrabbit), Pyke (epsilon)'

describe('castFromRoster', () => {
  // The owner's team is the second row on half of the loading screens. The model took the first row for the allies.
  it('finds the owner by the player name, also in the second group, and splits the two sides', () => {
    expect(castFromRoster(ROSTER, ['Some Game: moonrabbit'])).toBe(
      'The owner plays T1 Gnar (moonrabbit). Allies: Miss Fortune (delta), Pyke (epsilon). Opponents: Kayle (alpha), Zilean (beta), Nami (gamma).',
    )
  })

  it('matches a player name without its case, behind a tag, and from an account of a game with a colon', () => {
    const roster = 'Group 1: Ahri (OMG MoonRabbit), Lux (kiki) Group 2: Garen (taro)'

    expect(castFromRoster(roster, ['Tale: Part 2: moonrabbit'])).toBe('The owner plays Ahri (OMG MoonRabbit). Allies: Lux (kiki). Opponents: Garen (taro).')
  })

  it('takes the entry that the reply marked when no player name of the owner is known', () => {
    expect(castFromRoster('Group 1: Ahri (kiki), Lux (momo) Group 2: *Garen (taro), Jinx', [])).toBe('The owner plays Garen (taro). Allies: Jinx. Opponents: Ahri (kiki), Lux (momo).')
    // A reply also writes the mark before the player name, because the screen marks that name.
    expect(castFromRoster('Group 1: Ahri (kiki), Lux (momo) Group 2: Garen (*taro), Jinx', [])).toBe('The owner plays Garen (taro). Allies: Jinx. Opponents: Ahri (kiki), Lux (momo).')
    // A known player name wins over a mark, and a mark does not hide the name.
    expect(castFromRoster('Group 1: *Ahri (kiki), Lux (momo) Group 2: Jinx', ['Game: momo'])).toBe('The owner plays Lux (momo). Allies: Ahri (kiki). Opponents: Jinx.')
    expect(castFromRoster('Group 1: Ahri (kiki), Lux (*momo) Group 2: Jinx', ['Game: momo'])).toBe('The owner plays Lux (momo). Allies: Ahri (kiki). Opponents: Jinx.')
  })

  // A game without teams lists everyone in one group. A model can also copy two rows as one group.
  it('names no side for a roster of one group', () => {
    expect(castFromRoster('Group 1: Ahri (kiki), Lux (momo), Garen (taro)', ['Game: momo'])).toBe('The owner plays Lux (momo). Others: Ahri (kiki), Garen (taro).')
  })

  it('keeps the groups when it cannot tell the owner', () => {
    const cast = 'The owner plays: not known. Group 1: Ahri (kiki), Lux (momo). Group 2: Garen (taro).'

    expect(castFromRoster('Group 1: Ahri (kiki), Lux (momo) Group 2: Garen (taro)', ['Game: someone-else'])).toBe(cast)
    // Two entries with the name of the owner tell nothing.
    expect(castFromRoster('Group 1: Ahri (momo), Lux (momo)', ['Game: momo'])).toBe('The owner plays: not known. Group 1: Ahri (momo), Lux (momo).')
  })

  it('reads the punctuation that a model writes: full-width marks, a dot after a group, and a semicolon', () => {
    const roster = 'Group 1： ケイトリン（ひょう）、カルマ (oftoN). Group 2: レオナ (やばい); '

    expect(castFromRoster(roster, ['LoL: ofton'])).toBe('The owner plays カルマ (oftoN). Allies: ケイトリン (ひょう). Opponents: レオナ (やばい).')
  })

  it('reads a roster with the start of a second marker inside it', () => {
    expect(castFromRoster('Group 1: Ahri (kiki), Lux (momo)|CAST Group 2: Garen (taro)', ['Game: momo'])).toBe('The owner plays Lux (momo). Allies: Ahri (kiki). Opponents: Garen (taro).')
  })

  // A read of a screen without names answered "not known" for each one. That cast must not take the place of a good one.
  it('gives no cast for a roster with fewer than two names', () => {
    expect(castFromRoster('Group 1: not known (kiki), not known Group 2: unknown', ['Game: kiki'])).toBeUndefined()
    expect(castFromRoster('Group 1: Ahri (kiki)', ['Game: kiki'])).toBeUndefined()
  })

  describe('with the cast so far', () => {
    const current = 'The owner plays Lux (momo). Allies: Ahri (kiki). Opponents: Garen (taro), Jinx (nana).'

    // A scoreboard of the same match shows the same people, with a tag before a player name.
    it('gives no cast when the cast so far holds every character and player of the roster', () => {
      expect(castFromRoster('Group 1: Ahri (kiki), Lux (OMG momo) Group 2: Garen (taro), Jinx (nana)', ['Game: momo'], current)).toBeUndefined()
    })

    it('gives the new cast for other people, with no name of the cast so far', () => {
      expect(castFromRoster('Group 1: Zed (riku), Sona (umi) Group 2: Gnar (momo), Pyke (sora)', ['Game: momo'], current)).toBe('The owner plays Gnar (momo). Allies: Pyke (sora). Opponents: Zed (riku), Sona (umi).')
    })

    // The same players can start another match with other characters.
    it('gives the new cast when a known player has another character', () => {
      expect(castFromRoster('Group 1: Ahri (kiki), Zed (momo) Group 2: Garen (taro), Jinx (nana)', ['Game: momo'], current)).toBe('The owner plays Zed (momo). Allies: Ahri (kiki). Opponents: Garen (taro), Jinx (nana).')
    })

    // A scoreboard writes player names beside pictures. A model copied them as characters, with a few misread.
    it('gives no cast for a roster with few player names, because the cast so far holds pairs', () => {
      expect(castFromRoster('Group 1: kiki, OMG mono, Akali (sora) Group 2: taroo, nana', ['Game: momo'], current)).toBeUndefined()
      // An entry of a player name alone has no character.
      expect(castFromRoster('Group 1: (kiki), (mono) Group 2: (taroo), (nana)', ['Game: momo'], current)).toBeUndefined()
      // A game that writes no player names has a cast without pairs. A roster without pairs can then be new.
      expect(castFromRoster('Group 1: Zed, Sona Group 2: Gnar', [], 'The owner plays: not known. Group 1: Ahri, Lux.')).toBe('The owner plays: not known. Group 1: Zed, Sona. Group 2: Gnar.')
    })

    it('gives the fuller cast when the roster shows more people', () => {
      expect(castFromRoster('Group 1: Ahri (kiki), Lux (momo) Group 2: Garen (taro), Jinx (nana), Vi (sora)', ['Game: momo'], current)).toContain('Vi (sora)')
    })
  })

  it('leaves a cast in free words as it is', () => {
    const cast = 'The owner plays Ambessa. Allies: Karma. Opponents: Leona.'

    expect(castFromRoster(cast, ['Game: momo'])).toBe(cast)
  })
})
