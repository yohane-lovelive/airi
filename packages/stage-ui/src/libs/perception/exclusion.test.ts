import { describe, expect, it } from 'vitest'

import { DEFAULT_PERCEPTION_EXCLUSIONS, exclusionMatch } from './exclusion'

describe('exclusionMatch', () => {
  it('matches the app name, the app file name, or the title, without case', () => {
    expect(exclusionMatch({ title: 'Vault', app: 'Bitwarden' }, ['bitwarden'])).toBe('bitwarden')
    expect(exclusionMatch({ title: 'Vault', app: 'Electron', path: 'C:\\Apps\\KeePassXC\\KeePassXC.exe' }, ['KeePassXC'])).toBe('KeePassXC')
    expect(exclusionMatch({ title: 'My Bank - Login', app: 'Google Chrome' }, ['Bank'])).toBe('Bank')
  })

  it('matches an English entry as a whole word only', () => {
    expect(exclusionMatch({ title: 'Online shopping', app: 'Google Chrome' }, ['LINE'])).toBeUndefined()
    expect(exclusionMatch({ title: 'LINE', app: 'LINE' }, ['LINE'])).toBe('LINE')
  })

  it('matches a Japanese entry anywhere in the title', () => {
    expect(exclusionMatch({ title: '〇〇銀行 ログイン - Vivaldi', app: 'Vivaldi' }, ['銀行'])).toBe('銀行')
  })

  it('skips empty entries, and the default list excludes messengers', () => {
    expect(exclusionMatch({ title: 'Game', app: 'Game' }, ['', '  '])).toBeUndefined()
    expect(exclusionMatch({ title: '#general - Discord', app: 'Discord' }, DEFAULT_PERCEPTION_EXCLUSIONS)).toBe('Discord')
    expect(exclusionMatch({ title: 'League of Legends', app: 'League of Legends' }, DEFAULT_PERCEPTION_EXCLUSIONS)).toBeUndefined()
  })
})
