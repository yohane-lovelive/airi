/**
 * The settings that synchronize between devices, by group. Each group is one
 * synchronized document, and each key is a `localStorage` key.
 *
 * The list allows keys one by one. A new setting stays on the device until
 * someone adds it here. Do not add:
 * - Secrets, for example API keys, tokens, or the voiceprint. The server keeps
 *   values as plain JSON.
 * - Values of one device, for example audio devices, window placement, render
 *   quality, camera framing, or connection addresses.
 * - Features that must run on one device only, for example the Discord bot or
 *   missions.
 *
 * The design record is `server/docs/ai/adr/2026-10-31-settings-sync.md`.
 */
export const SETTINGS_SYNC_GROUPS = {
  general: [
    'settings/language',
    'settings/theme/colors/hue',
    'settings/theme/colors/hue-dynamic',
    'settings/disable-transitions',
    'settings/use-page-specific-transitions',
    'settings/streamer-mode',
    'settings/tool-cards/enabled',
    'settings/tool-cards/reply-cards',
    'settings/stickers/enabled',
    'settings/stickers/frequency',
    'ui/chat/settings/send-mode',
  ],
  consciousness: [
    'settings/consciousness/active-provider',
    'settings/consciousness/active-model',
    'settings/consciousness/active-custom-model',
  ],
  speech: [
    'settings/speech/enabled',
    'settings/speech/active-provider',
    'settings/speech/active-model',
    'settings/speech/voice',
    'settings/speech/pitch',
    'settings/speech/rate',
    'settings/speech/ssml-enabled',
  ],
  hearing: [
    'settings/hearing/enabled',
    'settings/hearing/active-provider',
    'settings/hearing/active-model',
    'settings/hearing/active-custom-model',
    'settings/hearing/input-mode',
    'settings/hearing/auto-send-enabled',
    'settings/hearing/auto-send-delay',
    'settings/hearing/confidence-threshold',
    'settings/hearing/end-judge-enabled',
    'settings/hearing/rephrase-enabled',
    'settings/hearing/rephrase-provider',
    'settings/hearing/rephrase-model',
    'settings/hearing/speaker-recognition-enabled',
  ],
  vision: [
    'settings/vision/enabled',
    'settings/vision/active-provider',
    'settings/vision/active-model',
    'settings/vision/active-custom-model',
    'settings/vision/ollama-thinking-enabled',
    'settings/vision/use-for-chat',
    'settings/vision/use-for-tool-images',
  ],
  live2d: [
    'settings/live2d/expression-enabled',
    'settings/live2d/eye-tracking',
    'settings/live2d/idle-animation-enabled',
    'settings/live2d/idle-eye-animation-enabled',
    'settings/live2d/model-eye-offset',
    'settings/live2d/motion-driver',
    'settings/live2d/shadow-enabled',
    'settings/live2d/magic/force-view-target',
    'settings/live2d/magic/profile',
    'settings/live2d/magic/skip-mouth-open',
  ],
  vrm: [
    'settings/stage-ui-three/envEnabled',
    'settings/stage-ui-three/skyBoxIntensity',
    'settings/stage-ui-three/trackingMode',
    'settings/stage-ui-three/scenes/scene/ambient-light/color',
    'settings/stage-ui-three/scenes/scene/ambient-light/intensity',
    'settings/stage-ui-three/scenes/scene/directional-light/color',
    'settings/stage-ui-three/scenes/scene/directional-light/intensity',
    'settings/stage-ui-three/scenes/scene/directional-light/position',
    'settings/stage-ui-three/scenes/scene/directional-light/rotation',
    'settings/stage-ui-three/scenes/scene/directional-light/target',
    'settings/stage-ui-three/scenes/scene/hemisphere-light/ground-color',
    'settings/stage-ui-three/scenes/scene/hemisphere-light/intensity',
    'settings/stage-ui-three/scenes/scene/hemisphere-light/sky-color',
  ],
  spine: [
    'settings/spine/default-mix',
    'settings/spine/idle-enabled',
    'settings/spine/premultiplied-alpha',
  ],
  modules: [
    'settings/web-search/enabled',
    'settings/web-search/provider',
    'settings/home-assistant/enabled',
    'settings/home-assistant/exposure-mode',
    'settings/home-assistant/allowed-entities',
    'settings/home-assistant/denied-entities',
    'artistry-provider',
    'artistry-model',
    'artistry-prompt-prefix',
    'memory/enabled',
    'recipes/proposals-enabled',
  ],
} as const satisfies Record<string, readonly string[]>

export type SettingsSyncGroup = keyof typeof SETTINGS_SYNC_GROUPS

/** The group of each synchronized key. */
export const SETTINGS_SYNC_KEY_GROUPS: ReadonlyMap<string, SettingsSyncGroup> = new Map(
  Object.entries(SETTINGS_SYNC_GROUPS).flatMap(([group, keys]) => keys.map(key => [key, group as SettingsSyncGroup])),
)
