import { ref, computed, watch, onBeforeUnmount, type Ref } from 'vue'
import * as pdfjs from 'pdfjs-dist'
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import {
  useAuthStore,
  useClientService,
  useSpacesStore,
  usePasswordPolicyService
} from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import { useLlm, type LlmConfig, type LlmModelOption, type LlmStatus } from './useLlm'

export const TEXT_EXTENSIONS = new Set(['txt', 'md'])
const MAX_CONTENT_CHARS = 12_000

const MAX_CACHE_ENTRIES = 20
const messageCache = new Map<string, ChatMessage[]>()

export interface ChatResource {
  id?: string
  name?: string
  extension?: string
  storageId?: string
  path?: string
  isFolder?: boolean
}

/** One tool execution performed by the Taki tool loop (folder chat) */
export interface ToolTraceEntry {
  tool: string
  path?: string
  method?: string
  chars?: number
  truncated?: boolean
  error?: string
  ms?: number
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** Full proposed file content returned via the apply_edit tool call, if any */
  editProposal?: string
  /** Original file content at the time the edit was proposed, used to compute the diff */
  originalContent?: string
  /** True once the edit has been written to the file */
  applied?: boolean
  /** Tool executions performed for this answer (folder chat only) */
  toolTrace?: ToolTraceEntry[]
}

export interface UseChatResult {
  status: Ref<LlmStatus>
  models: Ref<LlmModelOption[]>
  selectedModelId: Ref<string>
  /** Chain-of-thought toggle (persisted); sent as explicit enable_thinking */
  thinking: Ref<boolean>
  /** True when the file text exceeds MAX_CONTENT_CHARS (only the beginning reaches the model) */
  fileTruncated: Ref<boolean>
  /** True when the open resource is a folder (tool-based folder chat) */
  isFolder: Ref<boolean>
  messages: Ref<ChatMessage[]>
  isLoading: Ref<boolean>
  isApplying: Ref<boolean>
  panelError: Ref<string | null>
  sendMessage: (text: string, mode: 'chat' | 'edit') => Promise<void>
  applyEdit: (proposal: string, index: number) => Promise<void>
  discardEdit: (index: number) => void
  clearChat: () => void
  ensureReady: () => void
}

export function useChat(
  llmConfig: LlmConfig | null,
  resource: Ref<ChatResource | null | undefined>
): UseChatResult {
  const { $gettext } = useGettext()
  const { status, config, models, selectedModelId, selectedModel, thinking, ensureReady } =
    useLlm(llmConfig)
  const authStore = useAuthStore()
  const clientService = useClientService()
  const spacesStore = useSpacesStore()
  const passwordPolicyService = usePasswordPolicyService()
  const graphClient = clientService.graphAuthenticated

  const isFolder = computed(() => resource.value?.isFolder === true)

  const resourceId = resource.value?.id ?? ''
  const messages = ref<ChatMessage[]>(messageCache.get(resourceId) ?? [])
  const isLoading = ref(false)
  const isApplying = ref(false)
  const panelError = ref<string | null>(null)
  const fileTruncated = ref(false)

  // Ephemeral public link share for folder chat (same mechanism as the job
  // pipelines). Taki reads the folder through this share only — it never
  // sees the user token. In-memory per panel instance; the 1h server-side
  // expiry is the backstop if the cleanup below is missed.
  interface FolderShare {
    permId: string
    driveId: string
    itemId: string
    token: string
    password: string
    createdAt: number
  }
  let folderShare: FolderShare | null = null
  // Recreate before the 1h server-side expiry instead of after failing on it
  const SHARE_TTL_MS = 50 * 60 * 1000

  async function releaseFolderShare(): Promise<void> {
    if (!folderShare) {
      return
    }
    const { driveId, itemId, permId } = folderShare
    folderShare = null
    try {
      await graphClient.permissions.deletePermission(driveId, itemId, permId)
    } catch {
      // share may already be expired — the 1h expiry is the backstop
    }
  }

  async function ensureFolderShare(): Promise<FolderShare> {
    const res = resource.value
    if (!res?.id || !res?.storageId) {
      throw new Error($gettext('Folder location not available'))
    }
    if (folderShare && Date.now() - folderShare.createdAt < SHARE_TTL_MS) {
      return folderShare
    }
    await releaseFolderShare()

    const space = spacesStore.getSpace(res.storageId)
    if (!space) {
      throw new Error($gettext('Could not resolve folder space'))
    }
    // The root of a personal space cannot be public-linked
    if ((space as { driveType?: string }).driveType === 'personal' && res.path === '/') {
      throw new Error(
        $gettext(
          'The root of a personal space cannot be shared for chat. Select a folder inside it instead.'
        )
      )
    }

    const password = passwordPolicyService.generatePassword()
    const link = await graphClient.permissions.createLink(space.id, res.id, {
      type: 'view',
      password,
      expirationDateTime: new Date(Date.now() + 3600 * 1000).toISOString()
    })
    const webUrl = link.webUrl
    if (!webUrl) {
      throw new Error($gettext('Could not create the temporary folder link'))
    }
    const token = new URL(webUrl).pathname.split('/').pop() ?? ''
    if (!token) {
      throw new Error($gettext('Could not create the temporary folder link'))
    }

    folderShare = {
      permId: link.id,
      driveId: space.id,
      itemId: res.id,
      token,
      password,
      createdAt: Date.now()
    }
    return folderShare
  }

  onBeforeUnmount(() => {
    void releaseFolderShare()
  })

  watch(messages, (msgs) => {
    const id = resource.value?.id
    if (id) {
      if (messageCache.size >= MAX_CACHE_ENTRIES && !messageCache.has(id)) {
        const oldest = messageCache.keys().next().value
        if (oldest !== undefined) {
          messageCache.delete(oldest)
        }
      }
      messageCache.set(id, msgs)
    }
  })

  // Cache file text and ETag per resource to avoid redundant fetches within a session
  let cachedResourceId: string | undefined
  let cachedFileText: string | null = null
  let cachedFileEtag: string | null = null

  function buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = authStore.accessToken
    if (token) {
      h['Authorization'] = `Bearer ${token}`
    }
    return h
  }

  async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
    // Run the PDF.js worker in the main thread (fake worker mode) to avoid
    // Worker/CSP restrictions — same technique used by the AI summarizer.
    ;(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker
    const pdf = await pdfjs.getDocument({ data: buffer }).promise
    let text = ''
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      const pageText = content.items
        .filter((item): item is TextItem => 'str' in item)
        .map((item) => item.str)
        .join(' ')
      text = text ? text + '\n\n' + pageText : pageText
      if (text.length >= MAX_CONTENT_CHARS) {
        break
      }
    }
    return text
  }

  async function fetchFileText(): Promise<string> {
    const res = resource.value
    if (!res?.storageId || !res?.path) {
      throw new Error($gettext('Resource location not available'))
    }

    if (cachedResourceId === res.id && cachedFileText !== null) {
      return cachedFileText
    }

    const space = spacesStore.getSpace(res.storageId)
    if (!space) {
      throw new Error($gettext('Could not resolve file space'))
    }

    const ext = res.extension?.toLowerCase() ?? ''
    let text: string

    if (TEXT_EXTENSIONS.has(ext)) {
      const { response, headers } = await clientService.webdav.getFileContents(
        space,
        { path: res.path },
        { responseType: 'text' }
      )
      text = response.data as string
      const headerMap = headers as Record<string, string>
      const etagKey = Object.keys(headerMap).find((k) => k.toLowerCase() === 'etag')
      cachedFileEtag = etagKey !== undefined ? headerMap[etagKey] : null
      // Text files are fetched in full; chat truncates them at request time, so
      // exceeding the cap means part of the file is invisible to the model
      fileTruncated.value = text.length > MAX_CONTENT_CHARS
    } else {
      const { response } = await clientService.webdav.getFileContents(
        space,
        { path: res.path },
        { responseType: 'arraybuffer' }
      )
      // extractPdfText stops once MAX_CONTENT_CHARS is reached — hitting the
      // cap means the file has (at least) more content
      text = (await extractPdfText(response.data as ArrayBuffer)).slice(0, MAX_CONTENT_CHARS)
      cachedFileEtag = null
      fileTruncated.value = text.length >= MAX_CONTENT_CHARS
    }

    cachedResourceId = res.id
    cachedFileText = text
    return text
  }

  // Warm the text cache (and the truncation flag) as soon as a file is open,
  // so the truncation notice is visible before the first message is sent
  async function prefetchFileText(): Promise<void> {
    try {
      await fetchFileText()
    } catch {
      /* fetch errors surface on send */
    }
  }

  watch(
    () => resource.value?.id,
    (newId, oldId) => {
      if (newId && oldId && newId !== oldId) {
        panelError.value = null
        isApplying.value = false
        cachedFileText = null
        cachedResourceId = undefined
        cachedFileEtag = null
        void releaseFolderShare()
      }
      if (newId) {
        messages.value = messageCache.get(newId) ?? []
        fileTruncated.value = false
        if (cachedFileText === null && !isFolder.value) {
          prefetchFileText()
        }
      }
    },
    { immediate: true }
  )

  function aiErrorMessage(httpStatus: number): string {
    if (httpStatus === 401 || httpStatus === 403) {
      return $gettext(
        'Access to the AI service was denied. Your session may have expired — try reloading the page.'
      )
    }
    if (httpStatus === 404) {
      return $gettext(
        'The AI endpoint could not be found. Check the endpoint URL in admin settings.'
      )
    }
    if (httpStatus === 429) {
      return $gettext('The AI service is currently busy. Please try again in a moment.')
    }
    if (httpStatus >= 500) {
      return $gettext('The AI service is temporarily unavailable. Please try again later.')
    }
    return $gettext('The AI service returned an unexpected response. Please try again.')
  }

  async function sendMessage(text: string, mode: 'chat' | 'edit'): Promise<void> {
    if (isLoading.value) {
      return
    }
    if (isFolder.value) {
      // Folder chat runs against Taki's /chat/ask, which has its own default
      // model — the local endpoint config is not required for it.
      await sendFolderMessage(text)
      return
    }
    if (status.value === 'unconfigured') {
      return
    }

    const userMessage: ChatMessage = { role: 'user', content: text }
    messages.value = [...messages.value, userMessage]
    isLoading.value = true
    panelError.value = null

    try {
      const cfg = config.value
      if (!cfg) {
        messages.value = messages.value.slice(0, -1)
        return
      }
      if (!selectedModel.value) {
        messages.value = messages.value.slice(0, -1)
        return
      }
      const base = cfg.endpoint.replace(/\/$/, '')

      // Refuse to attach credentials or send file content to a cross-origin endpoint.
      // The intended path is browser → same-origin ai-llm-proxy → LLM; a foreign
      // endpoint would receive the user's oCIS bearer token.
      let endpointOrigin: string
      try {
        endpointOrigin = new URL(cfg.endpoint).origin
      } catch {
        endpointOrigin = ''
      }
      if (endpointOrigin !== window.location.origin) {
        messages.value = messages.value.slice(0, -1)
        panelError.value = $gettext(
          'The AI endpoint must be on the same server as ownCloud. Contact your administrator.'
        )
        return
      }

      const fileText = await fetchFileText()

      if (mode === 'edit' && fileText.length > MAX_CONTENT_CHARS) {
        messages.value = messages.value.slice(0, -1)
        panelError.value = $gettext(
          'This file is too large to edit here (limit: 12,000 characters). Use a text editor instead.'
        )
        return
      }

      let systemContent: string
      let requestMessages: Array<{ role: string; content: string }>

      if (mode === 'edit') {
        // Edit path: model returns ONLY new file content; no history needed.
        // fileText is guaranteed ≤ MAX_CONTENT_CHARS by the guard above.
        systemContent =
          `You are editing the file "${resource.value?.name ?? 'this file'}". ` +
          "Apply the user's instruction and return ONLY the complete updated file content. " +
          'Do not include any explanation, preamble, commentary, markdown fences, or surrounding text. ' +
          'Your entire response must be the raw file content and nothing else.' +
          `\n\n--- current file content ---\n${fileText}\n--- end of file content ---`
        requestMessages = [
          { role: 'system', content: systemContent },
          { role: 'user', content: text }
        ]
      } else {
        // Chat path: conversational, keeps history; truncate context for large files.
        const fileTextForContext = fileText.slice(0, MAX_CONTENT_CHARS)
        systemContent =
          `You are a helpful assistant. The user has opened the file "${resource.value?.name ?? 'this file'}". ` +
          'Answer questions about its content accurately and concisely.' +
          `\n\nFile content:\n${fileTextForContext}`
        requestMessages = [
          { role: 'system', content: systemContent },
          ...messages.value.map((m) => ({ role: m.role, content: m.content }))
        ]
      }

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(),
        // Generous safety-net ceiling, decoupled from the proxy's own (separately
        // configurable) upstream timeout; only guards against the network or proxy
        // never responding at all.
        signal: AbortSignal.timeout(300_000),
        body: JSON.stringify({
          model: selectedModel.value.model,
          messages: requestMessages,
          // Thinking needs more output budget for the chain-of-thought tokens
          max_tokens: thinking.value ? 16384 : 4096,
          // Always sent explicitly (on or off) so the request never depends on
          // server-side template defaults. No reasoning_effort: depth differs
          // per model and the native default is what we want.
          chat_template_kwargs: { enable_thinking: thinking.value }
        })
      })

      if (!res.ok) {
        throw new Error(aiErrorMessage(res.status))
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string | null }
          finish_reason?: string | null
        }>
      }

      if (mode === 'edit' && data.choices?.[0]?.finish_reason === 'length') {
        messages.value = messages.value.slice(0, -1)
        panelError.value = $gettext(
          'The AI response was cut off before the edit was complete. Try with a shorter instruction or a smaller file.'
        )
        return
      }

      let reply = (data.choices?.[0]?.message?.content ?? '').trim()

      if (mode === 'edit') {
        // Models sometimes fence their output despite being told not to.
        // Only strip when the whole response is wrapped (paired markers) so a
        // file legitimately opening with a fence is not mangled.
        if (/^```[\w]*\r?\n/.test(reply) && /\r?\n```\s*$/.test(reply)) {
          reply = reply.replace(/^```[\w]*\r?\n/, '').replace(/\r?\n```\s*$/, '')
        }
      }

      if (mode === 'edit' && reply) {
        messages.value = [
          ...messages.value,
          {
            role: 'assistant',
            content: $gettext('Edit ready — click "Apply to file" to save the changes.'),
            editProposal: reply,
            originalContent: fileText
          }
        ]
      } else {
        messages.value = [...messages.value, { role: 'assistant', content: reply }]
      }
    } catch (err) {
      // Roll back the optimistic user message so the user can retry cleanly
      messages.value = messages.value.slice(0, -1)
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        panelError.value = $gettext(
          'The AI service did not respond in time. Please try again later.'
        )
      } else if (err instanceof TypeError) {
        panelError.value = $gettext(
          'Could not reach the AI service. Check your network connection and try again.'
        )
      } else {
        panelError.value =
          err instanceof Error ? err.message : $gettext('Something went wrong. Please try again.')
      }
    } finally {
      isLoading.value = false
    }
  }

  // Folder chat: the model fetches folder content itself via tools, executed
  // server-side in Taki against an ephemeral public link share. No file text
  // ever passes through the client.
  async function sendFolderMessage(text: string): Promise<void> {
    const userMessage: ChatMessage = { role: 'user', content: text }
    messages.value = [...messages.value, userMessage]
    isLoading.value = true
    panelError.value = null

    try {
      const share = await ensureFolderShare()
      const folderName = resource.value?.name ?? ''

      // Taki builds the folder context into its own system prompt; we send the
      // conversation history. On the first exchange, nudge the model to
      // explore the folder before answering.
      const requestMessages = messages.value.map((m) => ({ role: m.role, content: m.content }))
      if (!requestMessages.some((m) => m.role === 'assistant')) {
        requestMessages[0] = {
          ...requestMessages[0],
          content:
            $gettext(
              'First explore this folder with your tools (list its contents, read the relevant files and images), then answer:'
            ) + '\n' + requestMessages[0].content
        }
      }

      const res = await fetch(`${window.location.origin}/chat/ask`, {
        method: 'POST',
        headers: buildHeaders(),
        signal: AbortSignal.timeout(300_000),
        body: JSON.stringify({
          // Empty when no local endpoint config exists — Taki falls back to
          // its configured default model.
          model: selectedModel.value?.model ?? '',
          messages: requestMessages,
          context: {
            share: { token: share.token, password: share.password },
            folder_name: folderName
          }
        })
      })

      if (!res.ok) {
        throw new Error(aiErrorMessage(res.status))
      }

      const data = (await res.json()) as {
        answer?: string
        tool_trace?: ToolTraceEntry[]
        iterations?: number
        error?: string
      }
      if (data.error) {
        throw new Error(data.error)
      }

      // Taki reports an expired/denied share as tool errors — drop the share
      // so the next send transparently recreates it.
      const trace = data.tool_trace ?? []
      if (trace.some((t) => /abgelaufen|verweigert|expired|denied/i.test(t.error ?? ''))) {
        await releaseFolderShare()
        throw new Error(
          $gettext('The temporary folder link has expired. Please send your message again.')
        )
      }

      const reply = (data.answer ?? '').trim()
      messages.value = [...messages.value, { role: 'assistant', content: reply, toolTrace: trace }]
    } catch (err) {
      // Roll back the optimistic user message so the user can retry cleanly
      messages.value = messages.value.slice(0, -1)
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        panelError.value = $gettext(
          'The AI service did not respond in time. Please try again later.'
        )
      } else if (err instanceof TypeError) {
        panelError.value = $gettext(
          'Could not reach the AI service. Check your network connection and try again.'
        )
      } else {
        panelError.value =
          err instanceof Error ? err.message : $gettext('Something went wrong. Please try again.')
      }
    } finally {
      isLoading.value = false
    }
  }

  async function applyEdit(proposal: string, index: number): Promise<void> {
    const res = resource.value
    if (!res?.storageId || !res?.path) {
      panelError.value = $gettext('Resource location not available')
      return
    }
    if (!TEXT_EXTENSIONS.has(res.extension?.toLowerCase() ?? '')) {
      panelError.value = $gettext('Editing is only supported for text files.')
      return
    }
    const space = spacesStore.getSpace(res.storageId)
    if (!space) {
      panelError.value = $gettext('Could not resolve file space')
      return
    }

    isApplying.value = true
    panelError.value = null
    try {
      await clientService.webdav.putFileContents(space, {
        path: res.path,
        content: proposal,
        previousEntityTag: cachedFileEtag ?? ''
      })
      messages.value = messages.value.map((msg, i) => {
        if (i !== index) return msg
        return { ...msg, content: $gettext('Edit applied successfully.'), applied: true }
      })
      cachedFileText = null
      cachedResourceId = undefined
      cachedFileEtag = null
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode
      if (status === 412) {
        panelError.value = $gettext(
          'The file was changed by someone else. Reload the panel and try again.'
        )
      } else {
        panelError.value = $gettext('Could not save the file. Please try again.')
      }
    } finally {
      isApplying.value = false
    }
  }

  function discardEdit(index: number): void {
    messages.value = messages.value.map((msg, i) => {
      if (i !== index) return msg
      return {
        ...msg,
        content: $gettext('Edit discarded.'),
        editProposal: undefined,
        originalContent: undefined
      }
    })
  }

  function clearChat(): void {
    const id = resource.value?.id
    if (id) {
      messageCache.delete(id)
    }
    messages.value = []
    isApplying.value = false
    panelError.value = null
    cachedFileText = null
    cachedResourceId = undefined
    cachedFileEtag = null
  }

  return {
    status,
    models,
    selectedModelId,
    thinking,
    fileTruncated,
    isFolder,
    messages,
    isLoading,
    isApplying,
    panelError,
    sendMessage,
    applyEdit,
    discardEdit,
    clearChat,
    ensureReady
  }
}
