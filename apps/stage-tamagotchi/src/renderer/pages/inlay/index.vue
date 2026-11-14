<script setup lang="ts">
import VoiceInlay from '../../components/inlay/voice-inlay.vue'

import { useHideDevToolsButton } from '../../composables/use-hide-dev-tools-button'

useHideDevToolsButton()
</script>

<template>
  <VoiceInlay />
</template>

<route lang="yaml">
meta:
  layout: stage
</route>
