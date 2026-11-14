import { defineStore } from 'pinia'
import { ref } from 'vue'

import { nextOwnerTypingUntil } from '../libs/initiative/typing'

/**
 * Whether the owner types in a chat input of any window.
 *
 * Each chat input sits in its own window, but the initiative runner runs on the leader. So the store replicates one
 * value: the time until which the owner counts as typing. A time ends by itself, so a window that closes while the
 * owner types leaves no stuck state. Nothing persists, because typing does not outlive a restart.
 *
 * Use when:
 * - A chat input reports owner input. Call `useOwnerTypingReport` there.
 * - Code waits while the owner types. Read `typingUntil` with `isOwnerTyping`.
 */
export const useOwnerTypingStore = defineStore('owner-typing', () => {
  /** Epoch milliseconds until which the owner counts as typing. `0` when the owner does not type. */
  const typingUntil = ref(0)

  /** Marks owner input now. Writes at most once for each refresh time. */
  function report() {
    const next = nextOwnerTypingUntil(typingUntil.value, Date.now())
    if (next !== undefined)
      typingUntil.value = next
  }

  /** Ends typing at once, for example when the input became empty or the owner sent the message. */
  function clear() {
    if (typingUntil.value !== 0)
      typingUntil.value = 0
  }

  return {
    typingUntil,
    report,
    clear,
  }
}, {
  synced: {
    state: true,
  },
})
