<script setup lang="ts">
import { IrodoriTtsSettings } from '@proj-airi/stage-ui/components'

const providerId = 'irodori-tts'
</script>

<template>
  <IrodoriTtsSettings
    :provider-id="providerId"
    default-text="こんにちは、はじめまして。今日もよろしくね。"
  />
</template>

<route lang="yaml">
  meta:
    layout: settings
    stageTransition:
      name: slide
</route>
