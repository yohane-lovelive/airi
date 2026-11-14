<script setup lang="ts">
import { usePerceptionIndicator } from '@proj-airi/stage-ui/composables/use-perception-indicator'

import ControlButtonTooltip from './control-button-tooltip.vue'
import ControlButton from './control-button.vue'

defineProps<{
  buttonStyle: string
  iconClass: string
}>()

// The button shows while screen perception is on, so the owner always sees it and can pause it with one click.
const { visible, active, recording, icon, label, press } = usePerceptionIndicator()
</script>

<template>
  <ControlButtonTooltip v-if="visible" side="inward" as-child>
    <ControlButton
      data-testid="controls-island-perception"
      :button-style
      :aria-label="label"
      :aria-pressed="active"
      @click="press"
    >
      <div
        :class="[
          iconClass,
          icon,
          recording ? 'text-red-500 dark:text-red-400' : active ? 'text-primary-600 dark:text-primary-300' : 'text-neutral-800 dark:text-neutral-300',
        ]"
      />
    </ControlButton>
    <template #tooltip>
      {{ label }}
    </template>
  </ControlButtonTooltip>
</template>
