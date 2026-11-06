import { describe, expect, it } from 'vitest'

import { BUILT_IN_GESTURES, GESTURE_CROSSFADE, gestureRotationTracks } from '../body-motion'
import { fixtureText } from './fixture-text'

describe('the fixtures of the C# tests of the Unity sidecar', () => {
  it('records the keys of the built-in gestures', async () => {
    const text = fixtureText({
      crossfade: GESTURE_CROSSFADE,
      gestures: BUILT_IN_GESTURES.map(gesture => ({
        id: gesture.id,
        duration: gesture.duration,
        tracks: gestureRotationTracks(gesture),
      })),
    })

    await expect(text).toMatchFileSnapshot('./character-fixtures/gestures.json')
  })
})
