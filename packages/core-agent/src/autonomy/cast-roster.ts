/** One entry of a roster: a character, and the player name that the screen writes beside it. */
interface RosterEntry {
  readonly character: string
  readonly player?: string
  /** The reply marked this entry, because the screen marks its player. */
  readonly marked: boolean
}

const GROUP = /Group\s*\d+\s*[:：]/gi
/** The mark of the owner. A reply writes it before the character or before the player name. */
const MARK = /^\*\s*/
const UNKNOWN = /^(?:not known|unknown)$/i

function normalized(text: string) {
  return text.normalize('NFKC').trim().toLowerCase()
}

/** Splits "Character (player name)" at its last opening bracket. An entry without brackets is a character alone. */
function partsOf(entry: string) {
  const open = /[)）]$/.test(entry) ? Math.max(entry.lastIndexOf('('), entry.lastIndexOf('（')) : -1
  return open < 0
    ? { rawCharacter: entry, rawPlayer: '' }
    : { rawCharacter: entry.slice(0, open).trim(), rawPlayer: entry.slice(open + 1, -1).trim() }
}

function entriesOf(group: string): RosterEntry[] {
  return group.split(/[,、]/).flatMap((part) => {
    const { rawCharacter, rawPlayer } = partsOf(part.trim().replace(/[.;。]+$/, '').trim())
    const character = rawCharacter.replace(MARK, '')
    if (!character || UNKNOWN.test(character))
      return []
    const player = rawPlayer.replace(MARK, '')
    return [{ character, ...(player ? { player } : {}), marked: MARK.test(rawCharacter) || MARK.test(rawPlayer) }]
  })
}

function label(entry: RosterEntry) {
  return entry.player ? `${entry.character} (${entry.player})` : entry.character
}

/** The player name of an account in the form "game: name". A game can hold a colon, so the last one counts. */
function playerNameOf(account: string) {
  const colon = account.lastIndexOf(': ')
  return normalized(colon < 0 ? account : account.slice(colon + 2))
}

/** A screen can write a tag before a player name, for example the tag of a team. So one word of the name can match. */
function isPlayer(entry: RosterEntry, names: readonly string[]) {
  if (!entry.player)
    return false
  const player = normalized(entry.player)
  return names.some(name => name && (player === name || player.split(/\s+/).includes(name)))
}

/** Whether a text holds a name: the whole name, or one of its words of three letters or more. A screen can add a tag to a name. */
function holds(text: string, name: string) {
  const wanted = normalized(name)
  return text.includes(wanted) || wanted.split(/\s+/).some(word => word.length >= 3 && text.includes(word))
}

/**
 * Turns the roster that a cast read copied from the screen into the cast of the scene.
 *
 * A cast read writes the list of the screen group by group: `Group 1: Character (player name), ... Group 2: ...`.
 * Code then finds the owner and the two sides, because the model took the wrong group for the allies in 3 of 8
 * probes of a screen with the owner in the second group.
 *
 * - The owner is the entry with one of the owner's player names. Without such a name, it is the entry that the reply
 *   marked with `*`.
 * - The allies are the other entries of the owner's group. The opponents are the entries of the other groups.
 * - A roster of one group tells no sides. The cast then lists the other entries as "Others".
 * - Without an owner, the cast keeps the groups, and says that the character of the owner is not known.
 *
 * Returns:
 * - The cast text, in the form that a turn about the screen reads.
 * - The text as it is, when it holds no group. A turn about the screen writes such a cast in its own words.
 * - `undefined` for a roster with fewer than two names. It tells nothing, so the cast before it stays.
 * - `undefined` for a roster whose characters and players are all in `current`. A scoreboard shows the same people
 *   again, and a second cast from it lost the character of the owner in a replay.
 * - `undefined` for a roster with few player names, when `current` holds player names. Such a roster is a list
 *   without written character names, for example a scoreboard with pictures.
 *
 * @param text The text of a cast marker.
 * @param ownerAccounts The owner's player names in games, each as "game: name".
 * @param current The cast of the scene so far.
 *
 * @example
 * castFromRoster('Group 1: Ahri (kiki), Lux (momo) Group 2: Garen (taro)', ['Some Game: momo'])
 * // => 'The owner plays Lux (momo). Allies: Ahri (kiki). Opponents: Garen (taro).'
 */
export function castFromRoster(text: string, ownerAccounts: readonly string[] = [], current?: string): string | undefined {
  // A model can start a second marker inside the first one. The stray word is no part of a name.
  const parts = text.replace(/[<|]*\bCAST\b/g, ' ').split(GROUP)
  if (parts.length < 2)
    return text
  const groups = parts.slice(1).map(entriesOf).filter(group => group.length)
  if (groups.flat().length < 2)
    return undefined
  const entries = groups.flat()
  const known = current ? normalized(current) : undefined
  if (known && entries.every(entry => holds(known, entry.character) && (!entry.player || holds(known, entry.player))))
    return undefined
  if (known && /[(（]/.test(known) && entries.filter(entry => entry.player).length * 2 < entries.length)
    return undefined

  const names = ownerAccounts.map(playerNameOf)
  const ownerOf = (test: (entry: RosterEntry) => boolean) => {
    const found = groups.flatMap((group, index) => group.filter(test).map(entry => ({ entry, index })))
    // Two entries with the owner's name tell nothing, for example a character with the same name as a player.
    return found.length === 1 ? found[0] : undefined
  }
  const owner = ownerOf(entry => isPlayer(entry, names)) ?? ownerOf(entry => entry.marked)
  if (!owner)
    return `The owner plays: not known. ${groups.map((group, index) => `Group ${index + 1}: ${group.map(label).join(', ')}.`).join(' ')}`

  const allies = groups[owner.index].filter(entry => entry !== owner.entry)
  const opponents = groups.filter((_, index) => index !== owner.index).flat()
  return [
    `The owner plays ${label(owner.entry)}.`,
    ...(allies.length ? [`${groups.length > 1 ? 'Allies' : 'Others'}: ${allies.map(label).join(', ')}.`] : []),
    ...(opponents.length ? [`Opponents: ${opponents.map(label).join(', ')}.`] : []),
  ].join(' ')
}
