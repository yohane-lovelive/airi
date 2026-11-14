<script setup lang="ts">
import type { MMDModelVariant } from '@proj-airi/stage-ui-mmd/utils/mmd-zip-loader'

import { Button } from '@proj-airi/ui'
import { useMediaQuery, useResizeObserver, useScreenSafeArea } from '@vueuse/core'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { DrawerContent, DrawerHandle, DrawerOverlay, DrawerPortal, DrawerRoot } from 'vaul-vue'
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * Lets the user choose one model of an MMD folder or ZIP that holds several, for example the outfits of one character.
 */
defineProps<{
  variants: MMDModelVariant[]
}>()

const emit = defineEmits<{
  choose: [variant: MMDModelVariant]
}>()

const { t } = useI18n()
const open = defineModel<boolean>('open', { default: false })
const isDesktop = useMediaQuery('(min-width: 768px)')
const screenSafeArea = useScreenSafeArea()

useResizeObserver(document.documentElement, () => screenSafeArea.update())
onMounted(() => screenSafeArea.update())

function choose(variant: MMDModelVariant) {
  emit('choose', variant)
  open.value = false
}
</script>

<template>
  <DialogRoot v-if="isDesktop" :open="open" @update:open="value => open = value">
    <DialogPortal>
      <DialogOverlay
        :class="[
          'fixed inset-0 z-[9999]',
          'bg-black/50 backdrop-blur-sm',
          'data-[state=closed]:animate-fadeOut data-[state=open]:animate-fadeIn',
        ]"
      />
      <DialogContent
        :class="[
          'fixed left-1/2 top-1/2 z-[9999]',
          'max-h-full max-w-xl w-[92dvw] overflow-y-auto',
          'rounded-2xl bg-white p-6 shadow-xl outline-none dark:bg-neutral-900',
          '-translate-x-1/2 -translate-y-1/2',
          'data-[state=closed]:animate-contentHide data-[state=open]:animate-contentShow',
        ]"
      >
        <DialogTitle :class="['text-lg font-semibold', 'text-neutral-900 dark:text-neutral-100']">
          {{ t('settings.model-select.select-model.mmd.choose-variant.title') }}
        </DialogTitle>
        <DialogDescription :class="['mt-1 mb-4', 'text-sm', 'text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.model-select.select-model.mmd.choose-variant.description') }}
        </DialogDescription>
        <div :class="['flex flex-col', 'gap-2']">
          <Button v-for="variant in variants" :key="variant.modelPath" :class="['justify-start']" @click="choose(variant)">
            {{ variant.name }}
          </Button>
        </div>
        <div :class="['mt-4', 'flex justify-end']">
          <Button variant="secondary" @click="open = false">
            {{ t('settings.model-select.select-model.mmd.choose-variant.cancel') }}
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>

  <DrawerRoot v-else :open="open" should-scale-background @update:open="value => open = value">
    <DrawerPortal>
      <DrawerOverlay class="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm" />
      <DrawerContent
        :class="[
          'fixed bottom-0 left-0 right-0 z-[9999]',
          'h-full max-h-[85%] flex flex-col',
          'rounded-t-2xl bg-neutral-50 px-4 pt-4 outline-none dark:bg-neutral-900/95',
        ]"
        :style="{ paddingBottom: `${Math.max(Number.parseFloat(screenSafeArea.bottom.value.replace('px', '')), 24)}px` }"
      >
        <DrawerHandle />
        <div :class="['mt-2 mb-1', 'text-lg font-semibold', 'text-neutral-900 dark:text-neutral-100']">
          {{ t('settings.model-select.select-model.mmd.choose-variant.title') }}
        </div>
        <div :class="['mb-4', 'text-sm', 'text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.model-select.select-model.mmd.choose-variant.description') }}
        </div>
        <div :class="['flex flex-1 flex-col', 'gap-2', 'overflow-y-auto pb-4']">
          <Button v-for="variant in variants" :key="variant.modelPath" :class="['justify-start']" @click="choose(variant)">
            {{ variant.name }}
          </Button>
        </div>
        <Button variant="secondary" @click="open = false">
          {{ t('settings.model-select.select-model.mmd.choose-variant.cancel') }}
        </Button>
      </DrawerContent>
    </DrawerPortal>
  </DrawerRoot>
</template>
