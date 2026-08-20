import {
  defineWebApplication,
  useResourcesStore,
  useSideBar
} from '@opencloud-eu/web-pkg'
import type { SidebarPanelExtension, ActionExtension, FileActionOptions } from '@opencloud-eu/web-pkg'
import { computed } from 'vue'
import { useGettext } from 'vue3-gettext'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import ChatPanel from './components/ChatPanel.vue'
import { isSupportedFile } from './utils/file-support'
import type { LlmConfig, LlmModelOption } from './composables/useLlm'

const SUPPORTED_EXTS = ['pdf', 'txt', 'md']
const APP_ID = 'chat-with-file'

export default defineWebApplication({
  setup({ applicationConfig }) {
    const { $pgettext } = useGettext()
    const resourcesStore = useResourcesStore()
    const sideBarStore = useSideBar() as any

    const rawLlm = applicationConfig?.llm as
      | Record<string, string | Array<Record<string, string>>>
      | undefined

    // Build the model list from `models:` (new) or fall back to a bare `model:` (legacy)
    const rawModels: Array<Record<string, string>> = Array.isArray(rawLlm?.models)
      ? (rawLlm.models as Array<Record<string, string>>)
      : rawLlm?.model
        ? [{ model: rawLlm.model as string }]
        : []

    const models: LlmModelOption[] = rawModels
      .filter((m) => typeof m.model === 'string' && m.model.length > 0)
      .map((m) => ({
        id: m.id || m.model,
        label: m.label || m.model,
        model: m.model
      }))

    const llmConfig: LlmConfig | null =
      rawLlm?.endpoint && models.length > 0
        ? { endpoint: rawLlm.endpoint as string, models }
        : null

    const extensions = computed(() => [
      {
        id: `${APP_ID}.panel`,
        type: 'sidebarPanel',
        extensionPointIds: ['global.files.sidebar'],
        panel: {
          name: APP_ID,
          icon: 'message',
          title: () => $pgettext('Sidebar panel tab title', 'Chat'),
          isVisible: ({ items }: { items?: Array<{ extension?: string; isFolder?: boolean }> }) =>
            items?.length === 1 &&
            (isSupportedFile(items[0], SUPPORTED_EXTS) || items[0]?.isFolder === true),
          component: ChatPanel,
          componentAttrs: ({ items }: { items?: Resource[] }) => ({
            resource: items?.[0] ?? null,
            llmConfig
          })
        }
      } as SidebarPanelExtension<SpaceResource, Resource, Resource>,
      {
        id: `${APP_ID}.action`,
        type: 'action',
        extensionPointIds: ['global.files.context-actions'],
        action: {
          name: `${APP_ID}-chat`,
          icon: 'message',
          label: () => $pgettext('Context menu action to open file chat', 'Chat with file'),
          isVisible: ({ resources }: { resources?: Array<{ extension?: string }> }) =>
            resources?.length === 1 && isSupportedFile(resources[0], SUPPORTED_EXTS),
          handler: ({ resources }: FileActionOptions) => {
            resourcesStore.setSelection(resources.map(({ id }) => id))
            sideBarStore.openSideBarPanel(APP_ID)
          }
        }
      } as ActionExtension,
      {
        id: `${APP_ID}.folder-action`,
        type: 'action',
        extensionPointIds: ['global.files.context-actions'],
        action: {
          name: `${APP_ID}-folder-chat`,
          icon: 'folder',
          label: () => $pgettext('Context menu action to open folder chat', 'Chat with folder'),
          isVisible: ({ resources }: { resources?: Array<{ isFolder?: boolean }> }) =>
            resources?.length === 1 && resources[0]?.isFolder === true,
          handler: ({ resources }: FileActionOptions) => {
            resourcesStore.setSelection(resources.map(({ id }) => id))
            sideBarStore.openSideBarPanel(APP_ID)
          }
        }
      } as ActionExtension
    ])

    return {
      appInfo: {
        name: $pgettext('Chat with File extension name', 'Chat with File'),
        id: APP_ID
      },
      extensions
    }
  }
})
