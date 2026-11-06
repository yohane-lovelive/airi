import { fixtureText } from '@proj-airi/stage-shared/stage-sidecar/fixture-text'
import { describe, expect, it } from 'vitest'

import { EMOTION_VALUES, EMOTION_VRMExpressionName_value } from './emotions'

describe('the fixtures of the C# tests of the Unity sidecar', () => {
  it('records the emotion names and their VRM expressions', async () => {
    const text = fixtureText({ emotions: EMOTION_VALUES, vrmExpressions: EMOTION_VRMExpressionName_value })

    await expect(text).toMatchFileSnapshot('../../../stage-shared/src/stage-sidecar/character-fixtures/emotions.json')
  })
})
