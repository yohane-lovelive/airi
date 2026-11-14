<script setup lang="ts">
import type { IrodoriReferenceClip, IrodoriReferenceVoice } from '@proj-airi/provider-inference'

import { errorMessageFrom } from '@moeru/std'
import {
  deleteIrodoriClip,
  IRODORI_CLIP_EXTENSIONS,
  IRODORI_MAX_REFERENCE_SECONDS,
  IRODORI_RECOMMENDED_REFERENCE_SECONDS,
  irodoriClipIdFor,
  irodoriReferenceSeconds,
  irodoriServerConfigOf,
  isIrodoriClipFile,
  moveIrodoriClip,
  uploadIrodoriClip,
} from '@proj-airi/provider-inference'
import { Alert, Button, Input, InputFile } from '@proj-airi/ui'
import { nanoid } from 'nanoid'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSpeechStore } from '../../../stores/modules/speech'
import { useProviderConfigStore } from '../../../stores/providers/config'

const props = defineProps<{
  providerId: string
}>()

const { t } = useI18n()
const providerStore = useProviderConfigStore()
const speechStore = useSpeechStore()

const newVoiceName = ref('')
const busyVoiceId = ref<string>()
const errorMessage = ref('')
const pickedFiles = ref<Record<string, File[] | undefined>>({})

const accept = IRODORI_CLIP_EXTENSIONS.join(',')

const config = computed(() => providerStore.getProviderConfig(props.providerId) ?? {})
const voices = computed(() => (config.value.referenceVoices as IrodoriReferenceVoice[] | undefined) ?? [])
const server = computed(() => irodoriServerConfigOf({ apiKey: config.value.apiKey as string | undefined, baseUrl: config.value.baseUrl as string | undefined }))

async function saveVoices(next: IrodoriReferenceVoice[]) {
  // The patch crosses windows through a BroadcastChannel, which cannot clone the
  // reactive proxies that the stored voices are read through.
  const plain = next.map(voice => ({
    clips: voice.clips.map(clip => ({ id: clip.id, name: clip.name, seconds: clip.seconds })),
    id: voice.id,
    name: voice.name,
  }))
  await providerStore.patchProviderConfig(props.providerId, { referenceVoices: plain })
  // The voice list of the speech module also carries the reference voices.
  await speechStore.loadVoicesForProvider(props.providerId)
}

async function run(voiceId: string, action: () => Promise<void>) {
  busyVoiceId.value = voiceId
  errorMessage.value = ''
  try {
    await action()
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? 'Unknown error'
  }
  finally {
    busyVoiceId.value = undefined
  }
}

function updateVoice(voiceId: string, update: (voice: IrodoriReferenceVoice) => IrodoriReferenceVoice) {
  return voices.value.map(voice => voice.id === voiceId ? update(voice) : voice)
}

async function addVoice() {
  const name = newVoiceName.value.trim()
  if (!name)
    return

  await run('', async () => {
    await saveVoices([...voices.value, { clips: [], id: nanoid(8), name }])
    newVoiceName.value = ''
  })
}

/** Measures a clip in the page. A file that the page cannot decode counts as zero seconds. */
async function measureSeconds(file: File) {
  try {
    const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await file.arrayBuffer())
    return decoded.duration
  }
  catch {
    return 0
  }
}

async function addClips(voice: IrodoriReferenceVoice, files: File[] | undefined) {
  pickedFiles.value = { ...pickedFiles.value, [voice.id]: undefined }
  if (!files?.length)
    return

  await run(voice.id, async () => {
    const added: IrodoriReferenceClip[] = []
    try {
      for (const file of files) {
        if (!isIrodoriClipFile(file.name))
          throw new Error(t('settings.pages.providers.provider.irodori-tts.reference.unsupported', { name: file.name }))

        const id = irodoriClipIdFor(voice.id, nanoid(6))
        await uploadIrodoriClip(server.value, id, file, file.name)
        added.push({ id, name: file.name, seconds: await measureSeconds(file) })
      }
    }
    finally {
      // Clips that reached the server before a failure stay in the voice, so the
      // owner can see them and remove them.
      if (added.length)
        await saveVoices(updateVoice(voice.id, item => ({ ...item, clips: [...item.clips, ...added] })))
    }
  })
}

async function moveClip(voice: IrodoriReferenceVoice, index: number, offset: number) {
  await run(voice.id, async () => {
    await saveVoices(updateVoice(voice.id, item => ({ ...item, clips: moveIrodoriClip(item.clips, index, offset) })))
  })
}

async function removeClip(voice: IrodoriReferenceVoice, clip: IrodoriReferenceClip) {
  await run(voice.id, async () => {
    await deleteIrodoriClip(server.value, clip.id)
    await saveVoices(updateVoice(voice.id, item => ({ ...item, clips: item.clips.filter(other => other.id !== clip.id) })))
  })
}

async function removeVoice(voice: IrodoriReferenceVoice) {
  await run(voice.id, async () => {
    for (const clip of voice.clips)
      await deleteIrodoriClip(server.value, clip.id)
    await saveVoices(voices.value.filter(item => item.id !== voice.id))
  })
}

async function renameVoice(voice: IrodoriReferenceVoice, name: string) {
  const trimmed = name.trim()
  if (!trimmed || trimmed === voice.name)
    return

  await run(voice.id, async () => {
    await saveVoices(updateVoice(voice.id, item => ({ ...item, name: trimmed })))
  })
}

function secondsLabel(seconds: number) {
  return `${seconds.toFixed(1)}s`
}
</script>

<template>
  <div :class="['flex flex-col gap-4']">
    <div>
      <div :class="['text-sm font-medium']">
        {{ t('settings.pages.providers.provider.irodori-tts.reference.title') }}
      </div>
      <div :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.providers.provider.irodori-tts.reference.description', { recommended: IRODORI_RECOMMENDED_REFERENCE_SECONDS, max: IRODORI_MAX_REFERENCE_SECONDS }) }}
      </div>
    </div>

    <Alert v-if="errorMessage" tone="danger" :title="t('settings.pages.providers.provider.irodori-tts.reference.failed')">
      <div :class="['whitespace-pre-wrap break-all']">
        {{ errorMessage }}
      </div>
    </Alert>

    <div
      v-for="voice in voices"
      :key="voice.id"
      :class="[
        'flex flex-col gap-3',
        'rounded-xl p-3',
        'bg-neutral-100/60 dark:bg-neutral-900/60',
      ]"
    >
      <div :class="['flex items-center gap-2']">
        <Input
          :model-value="voice.name"
          :class="['flex-1']"
          @change="renameVoice(voice, ($event.target as HTMLInputElement).value)"
        />
        <Button
          size="sm"
          color="red"
          icon="i-solar:trash-bin-trash-bold-duotone"
          :disabled="busyVoiceId !== undefined"
          @click="removeVoice(voice)"
        >
          {{ t('settings.pages.providers.provider.irodori-tts.reference.remove-voice') }}
        </Button>
      </div>

      <ol v-if="voice.clips.length" :class="['flex flex-col gap-1']">
        <li
          v-for="(clip, index) in voice.clips"
          :key="clip.id"
          :class="['flex items-center gap-2', 'text-sm']"
        >
          <span :class="['w-5 shrink-0 text-right text-xs text-neutral-500 dark:text-neutral-400']">{{ index + 1 }}</span>
          <span :class="['min-w-0 flex-1 truncate']" :title="clip.name">{{ clip.name }}</span>
          <span :class="['shrink-0 text-xs text-neutral-500 dark:text-neutral-400']">{{ secondsLabel(clip.seconds) }}</span>
          <Button
            size="sm"
            icon="i-solar:alt-arrow-up-linear"
            :aria-label="t('settings.pages.providers.provider.irodori-tts.reference.move-up')"
            :disabled="index === 0 || busyVoiceId !== undefined"
            @click="moveClip(voice, index, -1)"
          />
          <Button
            size="sm"
            icon="i-solar:alt-arrow-down-linear"
            :aria-label="t('settings.pages.providers.provider.irodori-tts.reference.move-down')"
            :disabled="index === voice.clips.length - 1 || busyVoiceId !== undefined"
            @click="moveClip(voice, index, 1)"
          />
          <Button
            size="sm"
            icon="i-solar:close-circle-linear"
            :aria-label="t('settings.pages.providers.provider.irodori-tts.reference.remove-clip')"
            :disabled="busyVoiceId !== undefined"
            @click="removeClip(voice, clip)"
          />
        </li>
      </ol>
      <div v-else :class="['text-xs text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.providers.provider.irodori-tts.reference.no-clips') }}
      </div>

      <div
        :class="[
          'text-xs',
          irodoriReferenceSeconds(voice.clips) > IRODORI_MAX_REFERENCE_SECONDS ? 'text-amber-600 dark:text-amber-400' : 'text-neutral-500 dark:text-neutral-400',
        ]"
      >
        {{ t('settings.pages.providers.provider.irodori-tts.reference.total', { seconds: irodoriReferenceSeconds(voice.clips).toFixed(1), max: IRODORI_MAX_REFERENCE_SECONDS }) }}
      </div>

      <InputFile
        :model-value="pickedFiles[voice.id]"
        :accept="accept"
        multiple
        :placeholder="busyVoiceId === voice.id ? t('settings.pages.providers.provider.irodori-tts.reference.uploading') : t('settings.pages.providers.provider.irodori-tts.reference.add-clips')"
        @update:model-value="addClips(voice, $event)"
      />
    </div>

    <div :class="['flex items-center gap-2']">
      <Input
        v-model="newVoiceName"
        :class="['flex-1']"
        :placeholder="t('settings.pages.providers.provider.irodori-tts.reference.new-voice-placeholder')"
        @keydown.enter="addVoice"
      />
      <Button
        size="sm"
        icon="i-solar:add-circle-linear"
        :disabled="!newVoiceName.trim() || busyVoiceId !== undefined"
        @click="addVoice"
      >
        {{ t('settings.pages.providers.provider.irodori-tts.reference.add-voice') }}
      </Button>
    </div>
  </div>
</template>
