import { defineConfig } from 'vitest/config'

// The unit tests need no network. The paid replay runs through `eval:run` only.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
