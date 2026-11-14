import type { Ref } from 'vue'

import { useIntervalFn } from '@vueuse/core'
import { watch } from 'vue'

import { OWNER_TYPING_REFRESH_MS } from '../libs/initiative/typing'
import { useOwnerTypingStore } from '../stores/owner-typing'

/**
 * Reports owner typing in one chat input, so autonomous speech waits while the owner writes.
 *
 * - A change to a draft with text marks typing. An empty draft, for example after a send, ends it at once.
 * - An input method editor does not change the draft while it composes. So typing stays marked for the whole
 *   composition, however long it takes.
 *
 * Use when:
 * - A chat surface has a draft that the owner sends to the character. Call it once in the component setup.
 */
export function useOwnerTypingReport(draft: Readonly<Ref<string>>, isComposing: Readonly<Ref<boolean>>) {
  const ownerTyping = useOwnerTypingStore()
  const composing = useIntervalFn(() => ownerTyping.report(), OWNER_TYPING_REFRESH_MS, { immediate: false })

  function reportDraft() {
    if (draft.value)
      ownerTyping.report()
    else
      ownerTyping.clear()
  }

  watch(draft, () => {
    if (!isComposing.value)
      reportDraft()
  })

  watch(isComposing, (value) => {
    if (value) {
      ownerTyping.report()
      composing.resume()
      return
    }
    composing.pause()
    reportDraft()
  })
}
