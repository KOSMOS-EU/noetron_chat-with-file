import { defineConfig } from '@opencloud-eu/extension-sdk'

export default defineConfig({
  name: 'web-app-chat-with-file',
  server: {
    port: 9730
  },
  test: {
    exclude: ['**/e2e/**']
  }
})
