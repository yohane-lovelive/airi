import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'

import { useHideDevToolsButton } from './use-hide-dev-tools-button'

/** The element that `vite-plugin-vue-devtools` adds for its floating button. */
function addDevToolsButton() {
  const button = document.createElement('div')
  button.id = '__vue-devtools-container__'
  button.textContent = 'V'
  document.body.appendChild(button)
  return button
}

describe('useHideDevToolsButton', () => {
  afterEach(() => {
    document.getElementById('__vue-devtools-container__')?.remove()
  })

  it('hides the DevTools button while the page that calls it is mounted', () => {
    const button = addDevToolsButton()
    const app = createApp(defineComponent({
      setup() {
        useHideDevToolsButton()
        return () => h('div')
      },
    }))
    app.mount(document.createElement('div'))

    expect(getComputedStyle(button).display).toBe('none')

    app.unmount()
    expect(getComputedStyle(button).display).not.toBe('none')
  })
})
