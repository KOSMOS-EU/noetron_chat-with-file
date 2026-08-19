import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'

export interface LlmModelOption {
  /** Stable identifier used for persistence; defaults to `model` */
  id: string
  /** Human readable name shown in the selector */
  label: string
  /** Model name sent to the LLM endpoint (e.g. a microllm alias) */
  model: string
}

export interface LlmConfig {
  endpoint: string
  models: LlmModelOption[]
}

export type LlmStatus = 'unconfigured' | 'ready'

const STORAGE_KEY = 'cwf.selectedModel'
const THINKING_KEY = 'cwf.thinking'

export interface UseLlmResult {
  status: Ref<LlmStatus>
  config: Ref<LlmConfig | null>
  models: Ref<LlmModelOption[]>
  selectedModelId: Ref<string>
  selectedModel: ComputedRef<LlmModelOption | null>
  /**
   * Chain-of-thought toggle, persisted in localStorage. Sent as an explicit
   * `chat_template_kwargs.enable_thinking` on every request (always on or off,
   * never left to the server default).
   */
  thinking: Ref<boolean>
  ensureReady: () => void
}

function readStoredModelId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function readStoredThinking(): boolean {
  try {
    return localStorage.getItem(THINKING_KEY) === '1'
  } catch {
    return false
  }
}

export function useLlm(initialConfig: LlmConfig | null): UseLlmResult {
  const status = ref<LlmStatus>('unconfigured')
  const config = ref<LlmConfig | null>(initialConfig)
  const models = ref<LlmModelOption[]>(config.value?.models ?? [])

  // Default to the stored selection if it still exists, otherwise the first model
  const stored = readStoredModelId()
  const selectedModelId = ref<string>(
    models.value.some((m) => m.id === stored) ? (stored as string) : (models.value[0]?.id ?? '')
  )

  const selectedModel = computed(
    () => models.value.find((m) => m.id === selectedModelId.value) ?? null
  )

  watch(selectedModelId, (id) => {
    try {
      if (id) {
        localStorage.setItem(STORAGE_KEY, id)
      }
    } catch {
      /* ignore (e.g. private browsing) */
    }
  })

  const thinking = ref<boolean>(readStoredThinking())

  watch(thinking, (on) => {
    try {
      localStorage.setItem(THINKING_KEY, on ? '1' : '0')
    } catch {
      /* ignore (e.g. private browsing) */
    }
  })

  function ensureReady() {
    status.value = config.value ? 'ready' : 'unconfigured'
  }

  return { status, config, models, selectedModelId, selectedModel, thinking, ensureReady }
}
