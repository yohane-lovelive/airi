<script setup lang="ts">
import { useMemoryStore } from '@proj-airi/stage-ui/stores/memory'
import { useMemoryWorkStore } from '@proj-airi/stage-ui/stores/memory-work'
import { useOwnerProfileStore } from '@proj-airi/stage-ui/stores/owner-profile'
import { Button, FieldCheckbox, FieldTextArea } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'

const KEY = 'settings.pages.modules.memory-long-term'
const { t } = useI18n()
const { enabled } = storeToRefs(useMemoryStore())
const memoryWork = useMemoryWorkStore()
const { enabled: workEnabled, lastWork, recentMerges } = storeToRefs(memoryWork)
const ownerProfile = useOwnerProfileStore()
const { enabled: profileEnabled, profile } = storeToRefs(ownerProfile)

/** The text in the editor. It follows the stored profile until the owner edits it. */
const draft = ref('')
watch(() => profile.value?.text, text => draft.value = text ?? '', { immediate: true })
const writing = ref(false)

async function writeProfileNow() {
  writing.value = true
  try {
    await memoryWork.writeProfileNow()
  }
  finally {
    writing.value = false
  }
}
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <div :class="['rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldCheckbox v-model="enabled" :label="t('settings.pages.modules.memory-long-term.enable')" :description="t('settings.pages.modules.memory-long-term.enable-description')" />
    </div>
    <div v-if="enabled" :class="['flex flex-col', 'gap-4', 'rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4']">
      <FieldCheckbox v-model="workEnabled" :label="t(`${KEY}.work.enable`)" :description="t(`${KEY}.work.enable-description`)" />
      <p v-if="lastWork" :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ lastWork.failed ? t(`${KEY}.work.last-failed`) : t(`${KEY}.work.last`, { count: lastWork.written }) }}
        <template v-if="!lastWork.failed && lastWork.merged">
          {{ t(`${KEY}.work.last-merged`, { count: lastWork.merged }) }}
        </template>
      </p>
      <div v-if="workEnabled && recentMerges.length" :class="['flex flex-col', 'gap-1']">
        <span :class="['text-sm font-medium']">{{ t(`${KEY}.work.merges`) }}</span>
        <p :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
          {{ t(`${KEY}.work.merges-description`) }}
        </p>
        <ul :class="['flex flex-col', 'gap-1']">
          <li v-for="merge in recentMerges" :key="merge.at" :class="['text-xs', 'text-neutral-600 dark:text-neutral-300', 'break-words']">
            {{ t(`${KEY}.work.merge`, { before: merge.before.join(' / '), after: merge.after, date: new Date(merge.at).toLocaleString() }) }}
          </li>
        </ul>
      </div>
      <FieldCheckbox v-model="profileEnabled" :label="t(`${KEY}.profile.enable`)" :description="t(`${KEY}.profile.enable-description`)" />
      <template v-if="profileEnabled">
        <FieldTextArea v-model="draft" :rows="6" :required="false" :label="t(`${KEY}.profile.text`)" :placeholder="t(`${KEY}.profile.empty`)" />
        <div :class="['flex flex-wrap', 'gap-2']">
          <Button size="sm" :label="t(`${KEY}.profile.save`)" :disabled="draft.trim() === (profile?.text ?? '')" @click="ownerProfile.set(draft)" />
          <Button size="sm" :label="t(`${KEY}.profile.write-now`)" :disabled="writing" @click="writeProfileNow()" />
          <Button size="sm" :label="t(`${KEY}.profile.clear`)" :disabled="!profile" @click="ownerProfile.clear()" />
        </div>
      </template>
    </div>
    <RouterLink
      to="/settings/modules/memory-long-term-recipes"
      :class="['rounded-lg', 'bg-neutral-50 dark:bg-neutral-800', 'p-4', 'flex items-center', 'gap-3', 'transition-colors', 'hover:bg-neutral-100 dark:hover:bg-neutral-700']"
    >
      <div :class="['i-solar:book-bookmark-bold-duotone', 'text-2xl', 'text-primary-500 dark:text-primary-400']" />
      <div :class="['flex-1', 'flex flex-col', 'gap-1']">
        <span :class="['text-lg font-medium']">{{ t('settings.pages.modules.memory-long-term.recipes.entry.title') }}</span>
        <span :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">{{ t('settings.pages.modules.memory-long-term.recipes.entry.description') }}</span>
      </div>
      <div :class="['i-solar:alt-arrow-right-linear', 'text-neutral-400']" />
    </RouterLink>
    <RouterLink
      to="/settings/modules/memory-long-term-memories"
      :class="['rounded-lg', 'bg-neutral-50 dark:bg-neutral-800', 'p-4', 'flex items-center', 'gap-3', 'transition-colors', 'hover:bg-neutral-100 dark:hover:bg-neutral-700']"
    >
      <div :class="['i-solar:notebook-bookmark-bold-duotone', 'text-2xl', 'text-primary-500 dark:text-primary-400']" />
      <div :class="['flex-1', 'flex flex-col', 'gap-1']">
        <span :class="['text-lg font-medium']">{{ t('settings.pages.modules.memory-long-term.memories.entry.title') }}</span>
        <span :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">{{ t('settings.pages.modules.memory-long-term.memories.entry.description') }}</span>
      </div>
      <div :class="['i-solar:alt-arrow-right-linear', 'text-neutral-400']" />
    </RouterLink>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-long-term.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
