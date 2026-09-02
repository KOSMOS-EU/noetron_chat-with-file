import {
  defineWebApplication,
  useAppsStore,
  useResourcesStore,
  useSideBar,
  useSpacesStore
} from '@opencloud-eu/web-pkg'
import type {
  SidebarPanelExtension,
  ActionExtension,
  FileActionOptions
} from '@opencloud-eu/web-pkg'
import { computed, ref, toRef } from 'vue'
import { useGettext } from 'vue3-gettext'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import ChatPanel from './components/ChatPanel.vue'
import { isSupportedFile } from './utils/file-support'
import translations from './l10n/translations.json'
import type { LlmConfig, LlmModelOption } from './composables/useLlm'

const SUPPORTED_EXTS = ['pdf', 'txt', 'md']
const APP_ID = 'chat-with-file'

export default defineWebApplication({
  setup({ applicationConfig }) {
    const { $gettext, $pgettext } = useGettext()
    const resourcesStore = useResourcesStore()
    const sideBarStore = useSideBar() as any
    const spacesStore = useSpacesStore()
    const appsStore = useAppsStore()

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

    // Drei Einstiegspunkte, drei Handler — jeder setzt einen klaren Zustand
    // im chatModeRef, den componentAttrs later liest.
    const chatModeRef = ref<'blank' | 'file' | 'folder'>('blank')

    const openBlankChat = () => {
      chatModeRef.value = 'blank'
      resourcesStore.resetSelection()
      sideBarStore.openSideBarPanel(APP_ID)
    }

    const openFileChat = (resources: Resource[]) => {
      chatModeRef.value = 'file'
      resourcesStore.setSelection(resources.map(({ id }) => id))
      sideBarStore.openSideBarPanel(APP_ID)
    }

    const openFolderChat = (resources: Resource[]) => {
      chatModeRef.value = 'folder'
      resourcesStore.setSelection(resources.map(({ id }) => id))
      sideBarStore.openSideBarPanel(APP_ID)
    }

    const extensions = computed(() => [
      {
        id: `${APP_ID}.new-menu-action`,
        type: 'action',
        extensionPointIds: ['app.files.upload-menu'],
        action: {
          name: `${APP_ID}-new-chat`,
          icon: 'message',
          label: () => $pgettext('New menu file type label', 'Create with Chat'),
          isVisible: () => spacesStore.currentSpace?.driveType === 'personal',
          handler: openBlankChat
        }
      } as ActionExtension,
      {
        id: `${APP_ID}.panel`,
        type: 'sidebarPanel',
        extensionPointIds: ['global.files.sidebar'],
        panel: {
          name: APP_ID,
          icon: 'message',
          // Tab-Titel spiegelt den aktiven Modus: im Personal Space ist der
          // offene Panel immer "Create with Chat" (Blank oder aktiver
          // Personal-Folder-Chat), in allen anderen Spaces "Chat".
          title: () =>
            spacesStore.currentSpace?.driveType === 'personal'
              ? $pgettext('Sidebar panel tab title (create mode)', 'Create with Chat')
              : $pgettext('Sidebar panel tab title', 'Chat'),
          isVisible: () => true,
          component: ChatPanel,
          componentAttrs: (context?: any) => {
            // Der Modus kommt strikt vom Einstiegspunkt (blank/file/folder-Handler).
            // Der Host-Context ist hier NICHT maßgeblich: ohne Selection reicht
            // FileSideBar den aktuellen Ordner als items[0] durch (und den Space
            // bei Root) — der würde den Folder-/File-Chat stillschweigend in den
            // "Create with Chat"-Modus kippen. Auswahl ohne Auswahl wird
            // stattdessen als leer behandelt (leeres Panel, kein Modus-Wechsel).
            const mode = chatModeRef.value
            let resource: Resource | null
            if (mode === 'folder') {
              // Breadcrumb-Trigger: selectedResources enthält nur die paginierte
              // Liste — der aktuelle Ordner ist dort nie enthalten. currentFolder
              // ist daher die verlässliche Quelle für den Ordner-Chat.
              resource = resourcesStore.currentFolder ?? null
            } else {
              const selected = resourcesStore.selectedResources[0] ?? null
              resource = mode !== 'blank' && selected ? selected : null
            }
            return {
              resource,
              llmConfig,
              isBlank: mode === 'blank' || undefined,
              chatMode: toRef(chatModeRef)
            }
          }
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
          handler: ({ resources }: FileActionOptions) => openFileChat(resources as Resource[])
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
          isVisible: ({ resources }: { resources?: Array<{ isFolder?: boolean; type?: string }> }) => {
            if (resources?.length !== 1) return false
            const r = resources[0]
            // isFolder kann bei manchen Resource-Objekten (z.B. Breadcrumb-Context)
            // undefined sein — dann auf type prüfen
            return r?.isFolder === true || r?.type === 'folder' || r?.type === 'directory'
          },
          handler: ({ resources }: FileActionOptions) => openFolderChat(resources as Resource[])
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
