/** The window in front, as the device reports it. */
export interface ForegroundWindow {
  readonly title: string
  /** The name of the app, for example "Google Chrome". */
  readonly app: string
  /** The path of the app file, for example `C:\Program Files\...\chrome.exe`. */
  readonly path?: string
}

/**
 * The default exclusion list: password managers, messengers, and words of banking in window titles.
 * The owner edits it in Settings.
 */
export const DEFAULT_PERCEPTION_EXCLUSIONS: readonly string[] = [
  '1Password',
  'Bitwarden',
  'KeePass',
  'KeePassXC',
  'LastPass',
  'Dashlane',
  'Enpass',
  'Discord',
  'LINE',
  'Slack',
  'Microsoft Teams',
  'Telegram',
  'WhatsApp',
  'Signal',
  'Messenger',
  'Bank',
  'Banking',
  '銀行',
  'ネットバンキング',
  '証券',
]

const ASCII_WORD = /^[\x20-\x7E]+$/

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The file name of an app path without its extension, for example `chrome` for `...\chrome.exe`. */
function fileNameOf(path: string) {
  return path.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, '') ?? ''
}

/**
 * Finds the entry of the exclusion list that matches a window: its app name, its app file name, or its title.
 * Case does not count. An English entry matches whole words only, so "LINE" does not match "Online".
 * Other entries, for example Japanese words, match anywhere.
 *
 * @example
 * exclusionMatch({ title: 'Vault - Bitwarden', app: 'Bitwarden' }, ['Bitwarden'])
 * // => 'Bitwarden'
 */
export function exclusionMatch(window: ForegroundWindow, entries: readonly string[]): string | undefined {
  const texts = [window.app, window.title, window.path ? fileNameOf(window.path) : ''].filter(Boolean)
  for (const raw of entries) {
    const entry = raw.trim()
    if (!entry)
      continue
    const pattern = ASCII_WORD.test(entry)
      ? new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(entry)}(?:$|[^a-z0-9])`, 'i')
      : undefined
    const lower = entry.toLowerCase()
    if (texts.some(text => pattern ? pattern.test(text) : text.toLowerCase().includes(lower)))
      return entry
  }
  return undefined
}
