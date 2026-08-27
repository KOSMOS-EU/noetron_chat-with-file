import { ref, computed, watch, onBeforeUnmount, type Ref } from 'vue'
import * as pdfjs from 'pdfjs-dist'
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import {
  useAuthStore,
  useAuthService,
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
  /** Search query (search_item / search_dir) */
  pattern?: string
  /** Additional structured filter combined via AND (search tools) */
  extra?: string
  method?: string
  chars?: number
  truncated?: boolean
  error?: string
  ms?: number
}

/** Live progress while the Taki tool loop runs (folder chat, streamed) */
export interface FolderProgress {
  /** Completed tool executions so far */
  count: number
  /** File currently being processed (undefined while the model thinks) */
  current?: string
  /** True between tool results, while the LLM decides the next step */
  thinking: boolean
  startedAt: number
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
  /**
   * Clickable answer options the model offered via present_options
   * (folder chat only). Clicking one sends it as the next user message.
   */
  options?: string[]
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
  /** True when no resource is open — blank chat („Create with Chat") */
  isBlank: Ref<boolean>
  /** Unique identifier of this chat session (stable across clearChat) */
  chatId: string
  messages: Ref<ChatMessage[]>
  isLoading: Ref<boolean>
  isApplying: Ref<boolean>
  panelError: Ref<string | null>
  /** Live tool-loop progress (folder chat only, null when idle) */
  folderProgress: Ref<FolderProgress | null>
  /** Index of the message currently being saved to the cloud (null when idle) */
  savingIndex: Ref<number | null>
  /** Indices of messages that were just saved (transient UI feedback) */
  savedIndices: Ref<number[]>
  sendMessage: (text: string, mode: 'chat' | 'edit') => Promise<void>
  applyEdit: (proposal: string, index: number) => Promise<void>
  discardEdit: (index: number) => void
  clearChat: () => void
  saveAnswer: (index: number) => Promise<void>
  /**
   * Transcribes an audio recording (mic) via Taki's /chat-direct/transcribe
   * (Whisper llm-stt). Resolves with the transcript text; rejects with an
   * Error on failure (unconfigured, too large, Taki error).
   */
  transcribeAudio: (audio: Blob, fileName: string) => Promise<string>
  ensureReady: () => void
}

/** Final payload of the Taki /chat/ask 'done' event (or the plain JSON answer) */
interface ChatAskData {
  answer?: string
  tool_trace?: ToolTraceEntry[]
  iterations?: number
  /** Answer options from present_options / loop break (clickable in the UI) */
  options?: string[]
  error?: string
}

/** One Server-Sent-Events frame from /chat/ask (stream: true) */
interface ChatStreamEvent {
  type: string
  [key: string]: unknown
}

/**
 * Reads the SSE stream of /chat/ask. Resolves with the 'done' payload,
 * rejects on an 'error' frame or a connection end without an answer.
 * onEvent is called for every other frame (start, phase, tool).
 * onActivity is called for every received chunk (also for Taki's
 * ': ping' heartbeat comments, which the frame parser below ignores).
 */
async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: ChatStreamEvent) => void,
  onActivity?: () => void
): Promise<ChatAskData> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let doneData: ChatAskData | null = null
  for (;;) {
    const { value, done: eof } = await reader.read()
    if (value) {
      buf += decoder.decode(value, { stream: true })
      onActivity?.()
    }
    let sep: number
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let name = ''
      let payload = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7)
        else if (line.startsWith('data: ')) payload = line.slice(6)
      }
      if (!name || !payload) continue
      const ev = JSON.parse(payload) as Record<string, unknown>
      if (name === 'done') {
        doneData = ev as unknown as ChatAskData
      } else if (name === 'error') {
        throw new Error(String(ev.error ?? 'unknown error from the AI service'))
      } else {
        onEvent({ ...ev, type: name })
      }
    }
    if (eof) break
  }
  if (!doneData) {
    throw new Error('The AI service ended the connection without a final answer.')
  }
  return doneData
}

export function useChat(
  llmConfig: LlmConfig | null,
  resource: Ref<ChatResource | null | undefined>
): UseChatResult {
  const { $gettext } = useGettext()
  const { status, config, models, selectedModelId, selectedModel, thinking, ensureReady } =
    useLlm(llmConfig)
  const authStore = useAuthStore()
  const authService = useAuthService()
  const clientService = useClientService()
  const spacesStore = useSpacesStore()
  const passwordPolicyService = usePasswordPolicyService()
  const graphClient = clientService.graphAuthenticated

  const isFolder = computed(() => resource.value?.isFolder === true)
  const isBlank = computed(() => resource.value === null || resource.value === undefined)

  // One unique chat identifier per panel session (survives clearChat, new
  // on every panel mount) — used as the chat key in saved .md filenames.
  const chatId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const resourceId = resource.value?.id ?? ''
  const messages = ref<ChatMessage[]>(messageCache.get(resourceId) ?? [])
  const isLoading = ref(false)
  const isApplying = ref(false)
  const panelError = ref<string | null>(null)
  /** Live tool-loop progress (folder chat, streamed from Taki) */
  const folderProgress = ref<FolderProgress | null>(null)
  const fileTruncated = ref(false)
  const savingIndex = ref<number | null>(null)
  const savedIndices = ref<number[]>([])

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

  // Blank chat workspace: the personal-space folder the AI is allowed to
  // write into (context.write.root). Created once per panel session.
  let workspaceRoot = 'workspace/'

  function buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = authStore.accessToken
    if (token) {
      h['Authorization'] = `Bearer ${token}`
    }
    return h
  }

  // ── Chat-Token (Taki, langlebig) ─────────────────────────────
  // Long folder chats (10–30 min) must not ride on the 5-minute IDP
  // bearer. Taki wraps the proxy-minted 1-day user JWT into an HMAC token
  // (GET /chat/token, still OIDC-gated) that the unprotected
  // /chat-direct route verifies itself. In-memory per panel instance;
  // the 24h/expiry of the embedded user JWT is the server-side bound.
  interface ChatToken {
    token: string
    /** Unix seconds, from Taki */
    exp: number
    /** When this token was fetched (ms) */
    fetchedAt: number
  }
  let chatTokenState: ChatToken | null = null
  // Re-fetch when less than this much validity remains…
  const CHAT_TOKEN_REFRESH_MARGIN_SECONDS = 300
  // …but never more often than this (minimum polling interval).
  const CHAT_TOKEN_MIN_FETCH_INTERVAL_MS = 60_000

  async function fetchChatToken(): Promise<ChatToken | null> {
    try {
      const res = await fetchWithAuthRetry(`${window.location.origin}/chat/token`, {
        method: 'GET',
        headers: buildHeaders()
      })
      if (!res.ok) {
        return null
      }
      const data = (await res.json()) as { token?: string; exp?: number }
      if (!data.token || typeof data.exp !== 'number') {
        return null
      }
      chatTokenState = { token: data.token, exp: data.exp, fetchedAt: Date.now() }
      return chatTokenState
    } catch {
      // Taki unreachable or endpoint missing (older build) — the legacy
      // /chat/ask route is used instead.
      return null
    }
  }

  async function ensureChatToken(): Promise<ChatToken | null> {
    const token = chatTokenState
    if (token) {
      const remainingSeconds = token.exp - Math.floor(Date.now() / 1000)
      const stale = remainingSeconds <= CHAT_TOKEN_REFRESH_MARGIN_SECONDS
      const tooSoon = Date.now() - token.fetchedAt < CHAT_TOKEN_MIN_FETCH_INTERVAL_MS
      if (!stale || tooSoon) {
        return token
      }
    }
    return fetchChatToken()
  }

  // POSTs the folder-chat request to /chat-direct/ask (chat token) and
  // falls back to the OIDC-gated /chat/ask (5-min bearer) when the chat
  // token is unavailable or rejected.
  async function postChatAsk(body: string, signal: AbortSignal): Promise<Response> {
    const init: RequestInit = { method: 'POST', body, signal }
    const directHeaders = (token: string): Record<string, string> => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    })
    const token = await ensureChatToken()
    if (token) {
      let res = await fetch('/chat-direct/ask', { ...init, headers: directHeaders(token.token) })
      if (res.status === 401) {
        // Token rejected (e.g. Taki restarted with a new secret) — force
        // one re-fetch and retry.
        const refreshed = await fetchChatToken()
        if (refreshed) {
          res = await fetch('/chat-direct/ask', {
            ...init,
            headers: directHeaders(refreshed.token)
          })
        }
      }
      // 401/403/404 = route or token not usable (e.g. older Taki without
      // the route) → fall back to the legacy OIDC-gated route below.
      if (res.status !== 401 && res.status !== 403 && res.status !== 404) {
        return res
      }
    }
    return fetchWithAuthRetry(`${window.location.origin}/chat/ask`, {
      ...init,
      headers: buildHeaders()
    })
  }

  // POSTs the audio blob to Taki's /chat-direct/transcribe (chat token) and
  // resolves with the transcript text. No legacy fallback — the route
  // requires a Taki build that has /chat-direct/transcribe.
  async function transcribeAudio(audio: Blob, fileName: string): Promise<string> {
    const token = await ensureChatToken()
    if (!token) {
      throw new Error('Chat-Token nicht verfügbar')
    }
    const form = new FormData()
    form.append('file', audio, fileName)
    let res = await fetch('/chat-direct/transcribe', {
      method: 'POST',
      body: form,
      headers: { Authorization: `Bearer ${token.token}` }
    })
    if (res.status === 401) {
      // Token rejected (e.g. Taki restarted with a new secret) — force one
      // re-fetch and retry.
      const refreshed = await fetchChatToken()
      if (refreshed) {
        res = await fetch('/chat-direct/transcribe', {
          method: 'POST',
          body: form,
          headers: { Authorization: `Bearer ${refreshed.token}` }
        })
      }
    }
    if (!res.ok) {
      let detail = `${res.status}`
      try {
        const data = (await res.json()) as { error?: string }
        if (data.error) {
          detail = data.error
        }
      } catch {
        /* non-JSON error body */
      }
      throw new Error(detail)
    }
    const data = (await res.json()) as { text?: string }
    if (!data.text) {
      throw new Error('leeres Transkript')
    }
    return data.text
  }

  // Ensures the personal-space workspace folder exists (blank chat write
  // root). MKCOL on an existing collection answers 405 — that is the
  // success case here, like in saveAnswer().
  async function ensureWorkspace(): Promise<void> {
    const space = spacesStore.spaces.find((s) => s.driveType === 'personal')
    if (!space) {
      throw new Error($gettext('Personal space not available'))
    }
    try {
      await webdavWithAuthRetry(() =>
        clientService.webdav.createFolder(space, { path: 'workspace', fetchFolder: false })
      )
    } catch (err) {
      // MKCOL on an existing collection answers 405 — that is the success case here
      if ((err as { statusCode?: number })?.statusCode !== 405) {
        throw err
      }
    }
  }

  // The IDP access token is short-lived (5 min default) and normally kept
  // fresh by the host app's token timer. If that renewal chain breaks (e.g.
  // the tab was suspended while the user stepped away), a request can arrive
  // with a stale token and get a 401. Try a silent renewal once and retry
  // with the fresh token before surfacing an error.
  async function fetchWithAuthRetry(url: string, init: RequestInit): Promise<Response> {
    const res = await fetch(url, init)
    if (res.status !== 401 && res.status !== 403) {
      return res
    }
    const previousToken = authStore.accessToken
    try {
      await authService.signinSilent()
    } catch (error) {
      // Renewal failed (e.g. the IDP session is gone) — fall through with
      // the original 401/403 response.
      console.warn('fetchWithAuthRetry: silent renewal failed', error)
    }
    if (authStore.accessToken === previousToken) {
      console.warn('fetchWithAuthRetry: renewal did not change the access token')
      return res
    }
    const headers = new Headers(init.headers)
    if (authStore.accessToken) {
      headers.set('Authorization', `Bearer ${authStore.accessToken}`)
    }
    return fetch(url, { ...init, headers })
  }

  // WebDAV calls use the IDP token from call time; after a long session the
  // token can be stale → 401/403. Same pattern as fetchWithAuthRetry: silent
  // renewal once, then retry with the fresh token.
  async function webdavWithAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode
      if (status !== 401 && status !== 403) {
        throw err
      }
      const previousToken = authStore.accessToken
      try {
        await authService.signinSilent()
      } catch (renewalError) {
        console.warn('webdavWithAuthRetry: silent renewal failed', renewalError)
        throw err
      }
      if (authStore.accessToken === previousToken) {
        console.warn('webdavWithAuthRetry: renewal did not change the access token')
        throw err
      }
      return fn()
    }
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
        if (isFolder.value) {
          // Warm the chat token before the first message, so a long folder
          // chat starts without an extra token round trip on send.
          void ensureChatToken()
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
    if (isBlank.value) {
      // Blank chat („Create with Chat") also runs against Taki — no folder
      // share, but a write root in the personal space (when available).
      await sendBlankMessage(text)
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

      const res = await fetchWithAuthRetry(`${base}/chat/completions`, {
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

    // Declared outside the try: catch/finally must be able to read them even
    // if an early step (e.g. ensureFolderShare) throws before the watchdog
    // is set up.
    let inactivityAborted = false
    let lastActivity = Date.now()
    let watchdog: number | undefined
    // present_options / Loop-Abbruch: Taki schickt die Antwort-Optionen als
    // eigenes "options"-Event (und im done-Payload); an die finale Antwort
    // hängen, damit die UI sie als Buttons rendert.
    let pendingOptions: string[] = []

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

      // Server-side search scope: the shared folder's own reva resource id
      // — resource.id is already in the exact format the search service
      // expects (<storageid>$<spaceid> at the space root,
      // <storageid>$<spaceid>!<opaqueid> in subfolders, cf. FormatResourceID),
      // plus the folder path relative to the space root (Taki strips it from
      // hit paths). Without it Taki disables its search tools.
      const folderRes = resource.value
      const scope = folderRes?.id
        ? {
            resource_id: folderRes.id,
            path: folderRes.path ?? ''
          }
        : undefined

      folderProgress.value = { count: 0, thinking: true, startedAt: Date.now() }

      // Inactivity watchdog: Taki sends an SSE heartbeat while the LLM
      // waits, so any chunk counts as activity. Without data for a long
      // time the connection is (likely) dead behind the reverse proxy —
      // abort early with a clear message instead of waiting for the
      // 30-minute safety net.
      const WATCHDOG_MS = 90_000
      const abortController = new AbortController()
      watchdog = window.setInterval(() => {
        if (Date.now() - lastActivity > WATCHDOG_MS) {
          inactivityAborted = true
          abortController.abort()
        }
      }, 5_000)
      const res = await postChatAsk(
        JSON.stringify({
          // Empty when no local endpoint config exists — Taki falls back to
          // its configured default model.
          model: selectedModel.value?.model ?? '',
          messages: requestMessages,
          context: {
            share: { token: share.token, password: share.password },
            folder_name: folderName,
            scope
          },
          stream: true
        }),
        // Folder chat legitimately takes 10–20+ minutes (many LLM iterations
        // over a growing context, OCR on scans). The SSE progress events keep
        // the UI alive; this ceiling is only a safety net against a hung
        // connection.
        AbortSignal.any([AbortSignal.timeout(1800_000), abortController.signal])
      )

      if (!res.ok) {
        throw new Error(aiErrorMessage(res.status))
      }

      const contentType = res.headers.get('content-type') ?? ''
      let data: ChatAskData
      if (contentType.includes('text/event-stream') && res.body) {
        data = await readChatStream(
          res.body,
          (ev) => {
            if (ev.type === 'options' && Array.isArray(ev.options)) {
              pendingOptions = (ev.options as unknown[])
                .filter((o): o is string => typeof o === 'string' && o.trim() !== '')
                .slice(0, 5)
            }
            const p = folderProgress.value
            if (!p) return
            if (ev.type === 'tool') {
              const path = (ev.path as string) || ''
              const pattern = (ev.pattern as string) || ''
              const tool = (ev.tool as string) || ''
              folderProgress.value = {
                ...p,
                count: typeof ev.index === 'number' ? ev.index : p.count,
                current:
                  tool === 'list_directory'
                    ? path || $gettext('folder contents')
                    : path || pattern || tool,
                thinking: false
              }
            } else if (ev.type === 'phase') {
              folderProgress.value = { ...p, current: undefined, thinking: true }
            }
          },
          () => {
            lastActivity = Date.now()
          }
        )
      } else {
        // Older Taki without stream support → final JSON answer
        data = (await res.json()) as ChatAskData
        lastActivity = Date.now()
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
      const options = (data.options ?? pendingOptions)
        .filter((o) => typeof o === 'string' && o.trim() !== '')
        .slice(0, 5)
      const assistantMessage: ChatMessage = { role: 'assistant', content: reply, toolTrace: trace }
      if (options.length > 0) {
        assistantMessage.options = options
      }
      messages.value = [...messages.value, assistantMessage]
    } catch (err) {
      // Roll back the optimistic user message so the user can retry cleanly
      messages.value = messages.value.slice(0, -1)
      if (inactivityAborted) {
        panelError.value = $gettext(
          'No data from the AI service for over 90 seconds — the connection was interrupted. Please send your message again.'
        )
      } else if (err instanceof DOMException && err.name === 'TimeoutError') {
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
      window.clearInterval(watchdog)
      isLoading.value = false
      folderProgress.value = null
    }
  }

  // Blank chat („Create with Chat"): no resource, no folder share. Taki
  // injects its write tools for the personal-space workspace root and uses
  // its blank system prompt. The conversation runs through the same
  // /chat-direct/ask plumbing as the folder chat.
  async function sendBlankMessage(text: string): Promise<void> {
    const userMessage: ChatMessage = { role: 'user', content: text }
    messages.value = [...messages.value, userMessage]
    isLoading.value = true
    panelError.value = null

    let inactivityAborted = false
    let lastActivity = Date.now()
    let watchdog: number | undefined
    let pendingOptions: string[] = []
    let workspace: string | undefined

    try {
      // Write root is personal-space-only: if the personal space is not
      // available, Taki simply gets no write context and answers read-only.
      if (spacesStore.spaces.some((s) => s.driveType === 'personal')) {
        await ensureWorkspace()
        workspace = workspaceRoot
      }

      const requestMessages = messages.value.map((m) => ({ role: m.role, content: m.content }))
      if (!requestMessages.some((m) => m.role === 'assistant')) {
        requestMessages[0] = {
          ...requestMessages[0],
          content:
            $gettext(
              'First create a project directory in your workspace, then build what was asked (see your workspace instructions):'
            ) + '\n' + requestMessages[0].content
        }
      }

      folderProgress.value = { count: 0, thinking: true, startedAt: Date.now() }

      const WATCHDOG_MS = 90_000
      const abortController = new AbortController()
      watchdog = window.setInterval(() => {
        if (Date.now() - lastActivity > WATCHDOG_MS) {
          inactivityAborted = true
          abortController.abort()
        }
      }, 5_000)
      const res = await postChatAsk(
        JSON.stringify({
          model: selectedModel.value?.model ?? '',
          messages: requestMessages,
          context: {
            folder_name: '',
            ...(workspace ? { write: { root: workspace } } : {})
          },
          stream: true
        }),
        AbortSignal.any([AbortSignal.timeout(1800_000), abortController.signal])
      )

      if (!res.ok) {
        throw new Error(aiErrorMessage(res.status))
      }

      const contentType = res.headers.get('content-type') ?? ''
      let data: ChatAskData
      if (contentType.includes('text/event-stream') && res.body) {
        data = await readChatStream(
          res.body,
          (ev) => {
            if (ev.type === 'options' && Array.isArray(ev.options)) {
              pendingOptions = (ev.options as unknown[])
                .filter((o): o is string => typeof o === 'string' && o.trim() !== '')
                .slice(0, 5)
            }
            const p = folderProgress.value
            if (!p) return
            if (ev.type === 'tool') {
              const path = (ev.path as string) || ''
              const tool = (ev.tool as string) || ''
              folderProgress.value = {
                ...p,
                count: typeof ev.index === 'number' ? ev.index : p.count,
                current: path || tool,
                thinking: false
              }
            } else if (ev.type === 'phase') {
              folderProgress.value = { ...p, current: undefined, thinking: true }
            }
          },
          () => {
            lastActivity = Date.now()
          }
        )
      } else {
        data = (await res.json()) as ChatAskData
        lastActivity = Date.now()
      }
      if (data.error) {
        throw new Error(data.error)
      }

      const reply = (data.answer ?? '').trim()
      const options = (data.options ?? pendingOptions)
        .filter((o) => typeof o === 'string' && o.trim() !== '')
        .slice(0, 5)
      const assistantMessage: ChatMessage = { role: 'assistant', content: reply }
      if (options.length > 0) {
        assistantMessage.options = options
      }
      messages.value = [...messages.value, assistantMessage]
    } catch (err) {
      messages.value = messages.value.slice(0, -1)
      if (inactivityAborted) {
        panelError.value = $gettext(
          'No data from the AI service for over 90 seconds — the connection was interrupted. Please send your message again.'
        )
      } else if (err instanceof DOMException && err.name === 'TimeoutError') {
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
      window.clearInterval(watchdog)
      isLoading.value = false
      folderProgress.value = null
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

  /**
   * Save one assistant answer as Markdown into the user's personal space
   * (folder "Chats", created on demand): <YYYY-MM-DD_HH-mm-ss>_<chatId>.md
   */
  async function saveAnswer(index: number): Promise<void> {
    const msg = messages.value[index]
    if (!msg || msg.role !== 'assistant' || savingIndex.value !== null) {
      return
    }
    const space = spacesStore.spaces.find((s) => s.driveType === 'personal')
    if (!space) {
      panelError.value = $gettext('Personal space not available')
      return
    }

    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
    const header = [
      `# ${$gettext('Chat response')}`,
      '',
      `- ${$gettext('Chat')}: ${chatId}`,
      `- ${$gettext('Date')}: ${date} ${time.replace(/-/g, ':')}`,
      ...(selectedModel.value ? [`- ${$gettext('Model')}: ${selectedModel.value.label}`] : []),
      ...(resource.value?.name ? [`- ${$gettext('Source')}: ${resource.value.name}`] : []),
      '',
      '---',
      ''
    ].join('\n')

    savingIndex.value = index
    panelError.value = null
    try {
      try {
        await webdavWithAuthRetry(() =>
          clientService.webdav.createFolder(space, { path: 'Chats', fetchFolder: false })
        )
      } catch (err) {
        // MKCOL on an existing collection answers 405 — that is the success case here
        if ((err as { statusCode?: number })?.statusCode !== 405) {
          throw err
        }
      }
      await webdavWithAuthRetry(() =>
        clientService.webdav.putFileContents(space, {
          path: `Chats/${date}_${time}_${chatId}.md`,
          content: header + msg.content,
          overwrite: false
        })
      )
      savedIndices.value = [...savedIndices.value, index]
      setTimeout(() => {
        savedIndices.value = savedIndices.value.filter((i) => i !== index)
      }, 3000)
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode
      if (status === 412 || status === 409) {
        panelError.value = $gettext(
          'A file with the same name already exists. Try again in a moment.'
        )
      } else {
        panelError.value = $gettext('Could not save the response. Please try again.')
      }
    } finally {
      savingIndex.value = null
    }
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
    isBlank,
    chatId,
    messages,
    isLoading,
    isApplying,
    panelError,
    folderProgress,
    savingIndex,
    savedIndices,
    sendMessage,
    applyEdit,
    saveAnswer,
    discardEdit,
    clearChat,
    transcribeAudio,
    ensureReady
  }
}
