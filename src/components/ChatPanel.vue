<template>
  <div data-testid="chat-with-file-panel" class="chat-panel">
    <!-- Unconfigured placeholder (folder chat does not need the local endpoint config) -->
    <div v-if="status === 'unconfigured' && !isFolder" class="chat-placeholder">
      {{
        $gettext(
          'File chat is not set up yet. Contact your administrator to configure an AI endpoint.'
        )
      }}
    </div>

    <template v-else>
      <!-- Message history -->
      <div ref="messagesEl" class="chat-messages">
        <div v-if="messages.length === 0 && !panelError" class="chat-placeholder">
          <template v-if="isFolder">
            {{ $gettext('Ask a question about this folder.') }}
          </template>
          <template v-else-if="mode === 'edit'">
            {{ $gettext('Describe the change you want to make to this file.') }}
          </template>
          <template v-else>
            {{ $gettext('Ask a question about this file.') }}
          </template>
        </div>

        <template v-else>
          <div
            v-for="(message, index) in messages"
            :key="index"
            class="chat-message"
            :class="message.role === 'user' ? 'chat-message--user' : 'chat-message--assistant'"
          >
            <div
              class="chat-bubble"
              :class="message.role === 'user' ? 'chat-bubble--user' : 'chat-bubble--assistant'"
            >
              <pre v-if="message.role === 'user'" class="chat-content">{{
                message.content
              }}</pre>
              <div
                v-else
                class="chat-content chat-content--md"
                v-html="renderedHtml(index)"
              ></div>
              <!-- Copy / Save actions (assistant answers only) -->
              <div v-if="message.role === 'assistant'" class="chat-actions">
                <span
                  v-if="savedIndices.includes(index)"
                  class="chat-saved-label"
                  :aria-label="$pgettext('Save button success state', 'Saved')"
                >
                  {{ $pgettext('Save button success state', 'Saved') }}
                </span>
                <button
                  class="chat-action-btn"
                  :aria-label="
                    copiedIndex === index
                      ? $pgettext('Copy button success state', 'Copied to clipboard')
                      : $pgettext('Copy button label', 'Copy response to clipboard')
                  "
                  :title="
                    copiedIndex === index
                      ? $pgettext('Copy button success state', 'Copied to clipboard')
                      : $pgettext('Copy button label', 'Copy response to clipboard')
                  "
                  :disabled="copiedIndex === index"
                  @click="copyMessage(index)"
                >
                  <!-- check (copied) -->
                  <svg
                    v-if="copiedIndex === index"
                    xmlns="http://www.w3.org/2000/svg"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                  <!-- content_copy -->
                  <svg
                    v-else
                    xmlns="http://www.w3.org/2000/svg"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"
                    />
                  </svg>
                </button>
                <button
                  class="chat-action-btn"
                  :aria-label="$pgettext('Save button label', 'Save response as Markdown file')"
                  :title="$pgettext('Save button label', 'Save response as Markdown file')"
                  :disabled="savingIndex === index"
                  @click="saveAnswer(index)"
                >
                  <!-- save (floppy) -->
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"
                    />
                  </svg>
                </button>
              </div>
              <template v-if="message.toolTrace && message.toolTrace.length > 0">
                <button class="trace-toggle" @click="toggleTrace(index)">
                  <span class="diff-toggle-icon">{{ isTraceExpanded(index) ? '▾' : '▸' }}</span>
                  {{
                    isTraceExpanded(index)
                      ? $pgettext('Tool-trace toggle label', 'Hide file access')
                      : `${$pgettext('Tool-trace toggle label', 'File access')} (${message.toolTrace.length})`
                  }}
                </button>
                <div v-if="isTraceExpanded(index)" class="trace-list">
                  <div
                    v-for="(entry, ei) in message.toolTrace"
                    :key="ei"
                    class="trace-entry"
                  >
                    <span class="trace-tool">{{ entry.tool }}</span>
                    <span v-if="entry.path" class="trace-path">{{ entry.path }}</span>
                    <span v-if="entry.method" class="trace-flag trace-flag--method">{{ entry.method }}</span>
                    <span v-if="entry.chars > 0" class="trace-flag">{{ formatChars(entry.chars) }}</span>
                    <span v-if="entry.truncated" class="trace-flag trace-flag--warn">
                      {{ $pgettext('Tool-trace flag: file was truncated', 'truncated') }}
                    </span>
                    <span v-if="entry.error" class="trace-flag trace-flag--error">
                      {{ entry.error }}
                    </span>
                  </div>
                </div>
              </template>
              <template v-if="message.editProposal">
                <div class="chat-diff oc-mt-xs">
                  <button
                    v-if="message.applied"
                    class="diff-toggle"
                    @click="toggleDiff(index)"
                  >
                    <span class="diff-toggle-icon">{{ isDiffExpanded(index) ? '▾' : '▸' }}</span>
                    {{
                      isDiffExpanded(index)
                        ? $gettext('Hide changes')
                        : $gettext('Show changes')
                    }}
                  </button>
                  <div v-if="!message.applied || isDiffExpanded(index)">
                    <template v-if="getDiff(index).length > 0">
                      <div
                        class="diff-block"
                        :class="{ 'diff-block--tall': isDiffHeightExpanded(index) }"
                      >
                        <div
                          v-for="(line, li) in getDiff(index)"
                          :key="li"
                          class="diff-line"
                          :class="`diff-line--${line.type}`"
                        >{{ diffPrefix(line.type) }}{{ line.text }}</div>
                      </div>
                      <button
                        v-if="isDiffLong(index)"
                        class="diff-height-toggle"
                        @click="toggleDiffHeight(index)"
                      >
                        {{
                          isDiffHeightExpanded(index)
                            ? $gettext('Collapse')
                            : $gettext('Expand')
                        }}
                      </button>
                    </template>
                    <div v-else class="diff-empty">{{ $gettext('No changes detected.') }}</div>
                  </div>
                </div>
                <div v-if="!message.applied" class="chat-apply-row oc-mt-xs">
                  <oc-button
                    size="small"
                    appearance="outline"
                    :disabled="isApplying"
                    @click="discardEdit(index)"
                  >
                    {{ $pgettext('Button to discard a proposed file edit', 'Discard') }}
                  </oc-button>
                  <oc-button
                    size="small"
                    variant="primary"
                    :disabled="isApplying"
                    @click="applyEdit(message.editProposal, index)"
                  >
                    {{
                      isApplying
                        ? $pgettext('Button label while saving a file edit', 'Saving…')
                        : $pgettext('Button to apply a proposed file edit', 'Apply to file')
                    }}
                  </oc-button>
                </div>
              </template>
            </div>
          </div>
        </template>

        <div v-if="isLoading" class="chat-message chat-message--assistant oc-mb-xs">
          <div class="chat-bubble chat-bubble--assistant chat-bubble--loading">
            <template v-if="isFolder && folderProgress">
              <template v-if="folderProgress.thinking">
                {{ $gettext('Thinking…') }}
              </template>
              <template v-else>
                {{ $gettext('Working on…') }} {{ folderProgress.current }}
              </template>
              <span v-if="folderProgress.count > 0" class="loading-meta">
                ({{ folderProgress.count }} {{ $gettext('steps') }})
              </span>
            </template>
            <template v-else>{{ $gettext('Thinking…') }}</template>
          </div>
        </div>
      </div>

      <!-- Error banner -->
      <div v-if="panelError" class="chat-error oc-mb-s" role="alert">
        {{ panelError }}
      </div>

      <!-- Truncation notice (chat mode only: edit mode refuses oversized files) -->
      <div v-if="fileTruncated && mode !== 'edit'" class="chat-truncation-note oc-mb-s">
        {{ $gettext('This file is longer than 12,000 characters — only the beginning is used.') }}
      </div>

      <!-- Clear button -->
      <div v-if="messages.length > 0" class="oc-flex oc-flex-right oc-mb-xs">
        <oc-button size="small" appearance="raw" @click="clearChat">
          {{ $pgettext('Button to clear the chat history', 'Clear chat') }}
        </oc-button>
      </div>

      <!-- Unified input card -->
      <div class="chat-input-card" :class="{ 'chat-input-card--focused': isFocused }">
        <textarea
          v-model="inputText"
          class="chat-textarea"
          :aria-label="$gettext('Chat message input')"
          :placeholder="
            isFolder
              ? $gettext('Ask about this folder… (Enter to send)')
              : mode === 'edit'
                ? $gettext('Describe the change… (Enter to send)')
                : $gettext('Ask about this file… (Enter to send)')
          "
          :disabled="isLoading"
          rows="3"
          @focus="isFocused = true"
          @blur="isFocused = false"
          @keydown.enter.exact.prevent="submit"
        />
        <div class="chat-input-footer">
          <!-- Single Edit toggle: off = chat, on = edit, disabled = file not editable (e.g. PDF).
               Hidden in folder mode — there is no single file to edit. -->
          <button
            v-if="!isFolder"
            class="mode-pill"
            :class="{ 'mode-pill--active': mode === 'edit' }"
            :disabled="!isEditable"
            role="switch"
            :aria-checked="mode === 'edit'"
            :title="isEditable
              ? $gettext('Rewrite the file with the model (diff preview, then apply or discard)')
              : $gettext('Editing is only available for text files')"
            @click="mode = mode === 'edit' ? 'chat' : 'edit'"
          >
            {{ $pgettext('Edit toggle label', 'Edit') }}
          </button>

          <button
            class="mode-pill"
            :class="{ 'mode-pill--active': thinking }"
            role="switch"
            :aria-checked="thinking"
            :title="$gettext(
              'Let the model think (chain of thought) before answering. Applies from the next message.'
            )"
            @click="thinking = !thinking"
          >
            {{ $pgettext('Thinking toggle label', 'Think') }}
          </button>

          <oc-select
            v-if="models.length > 1"
            v-model="selectedModelId"
            class="model-select"
            :label="$pgettext('Model selector label', 'Model')"
            :label-hidden="true"
            :options="models"
            :reduce="reduceModelOption"
            :searchable="false"
          />

          <button
            class="send-btn"
            :disabled="isLoading || isApplying || !inputText.trim()"
            :aria-label="$gettext('Send message')"
            @click="submit"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, toRef, watch, nextTick, onMounted } from 'vue'
import { useGettext } from 'vue3-gettext'
import { useChat, TEXT_EXTENSIONS, type ChatResource } from '../composables/useChat'
import { renderMarkdown } from '../utils/markdown'
import type { LlmConfig, LlmModelOption } from '../composables/useLlm'
import { computeDiff } from '../utils/diff'
import type { DiffLineType } from '../utils/diff'

interface FlatLine {
  type: DiffLineType | 'sep'
  text: string
}

const { $gettext, $pgettext } = useGettext()

const props = defineProps<{
  resource?: ChatResource | null
  llmConfig?: LlmConfig | null
}>()

const {
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
  folderProgress,
  savingIndex,
  savedIndices,
  sendMessage,
  applyEdit,
  saveAnswer,
  discardEdit,
  clearChat,
  ensureReady
} = useChat(props.llmConfig ?? null, toRef(props, 'resource'))

// Markdown rendering for assistant answers (raw HTML, sanitized — see
// utils/markdown.ts). Keyed by content so the cache stays valid across
// clearChat() and resource switches.
const renderedHtmlCache = new Map<string, string>()
function renderedHtml(index: number): string {
  const content = messages.value[index]?.content ?? ''
  const cached = renderedHtmlCache.get(content)
  if (cached !== undefined) {
    return cached
  }
  const html = renderMarkdown(content)
  renderedHtmlCache.set(content, html)
  return html
}

// Copy feedback: index of the message just copied (transient, 2 s)
const copiedIndex = ref<number | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | undefined

async function copyMessage(index: number): Promise<void> {
  const msg = messages.value[index]
  if (!msg || copiedIndex.value === index) {
    return
  }
  try {
    await navigator.clipboard.writeText(msg.content)
  } catch {
    panelError.value = $gettext('Could not copy to clipboard.')
    return
  }
  copiedIndex.value = index
  if (copyTimer) {
    clearTimeout(copyTimer)
  }
  copyTimer = setTimeout(() => {
    copiedIndex.value = null
  }, 2000)
}

// DEBUG: temporarily trace model selection (remove once the single-option issue is resolved)
function reduceModelOption(option: LlmModelOption): string {
  console.debug('[cwf] oc-select reduce called for option:', JSON.stringify(option))
  return option.id
}

watch(selectedModelId, (newId, oldId) => {
  console.debug(`[cwf] selectedModelId changed: ${oldId} -> ${newId}`)
})

onMounted(() => {
  console.debug('[cwf] ChatPanel mounted, models:', JSON.stringify(models.value))
})

const inputText = ref('')
const messagesEl = ref<HTMLElement | null>(null)
const mode = ref<'chat' | 'edit'>('chat')
const isFocused = ref(false)

const isEditable = computed(() => {
  const ext = props.resource?.extension?.toLowerCase() ?? ''
  return TEXT_EXTENSIONS.has(ext)
})

// Keyed by `originalContent\0editProposal` so each proposal is computed at most once
// regardless of how many other messages change in the thread.
const diffCache = new Map<string, FlatLine[]>()

const messageDiffs = computed(() =>
  messages.value.map((msg): FlatLine[] | null => {
    if (!msg.editProposal || msg.originalContent === undefined) {
      return null
    }
    const key = `${msg.originalContent}\0${msg.editProposal}`
    const cached = diffCache.get(key)
    if (cached !== undefined) {
      return cached
    }
    const hunks = computeDiff(msg.originalContent, msg.editProposal)
    const flat: FlatLine[] = []
    for (const hunk of hunks) {
      flat.push({ type: 'sep', text: '@@ ... @@' })
      for (const line of hunk.lines) {
        flat.push(line)
      }
    }
    diffCache.set(key, flat)
    return flat
  })
)

function getDiff(index: number): FlatLine[] {
  return messageDiffs.value[index] ?? []
}

const DIFF_LONG_THRESHOLD = 12

function isDiffLong(index: number): boolean {
  return getDiff(index).length > DIFF_LONG_THRESHOLD
}

const expandedDiffHeights = ref<number[]>([])

function isDiffHeightExpanded(index: number): boolean {
  return expandedDiffHeights.value.includes(index)
}

function toggleDiffHeight(index: number): void {
  expandedDiffHeights.value = isDiffHeightExpanded(index)
    ? expandedDiffHeights.value.filter((i) => i !== index)
    : [...expandedDiffHeights.value, index]
}

const expandedDiffs = ref<number[]>([])

function isDiffExpanded(index: number): boolean {
  return expandedDiffs.value.includes(index)
}

function toggleDiff(index: number): void {
  expandedDiffs.value = isDiffExpanded(index)
    ? expandedDiffs.value.filter((i) => i !== index)
    : [...expandedDiffs.value, index]
}

// Tool-trace expansion (folder chat: which files the model accessed)
const expandedTraces = ref<number[]>([])

function isTraceExpanded(index: number): boolean {
  return expandedTraces.value.includes(index)
}

function toggleTrace(index: number): void {
  expandedTraces.value = isTraceExpanded(index)
    ? expandedTraces.value.filter((i) => i !== index)
    : [...expandedTraces.value, index]
}

function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k chars` : `${n} chars`
}

function diffPrefix(type: FlatLine['type']): string {
  if (type === 'added') return '+ '
  if (type === 'removed') return '- '
  if (type === 'unchanged') return '  '
  return ''
}

async function submit(): Promise<void> {
  const text = inputText.value.trim()
  if (!text || isLoading.value || isApplying.value) {
    return
  }
  inputText.value = ''
  await sendMessage(text, mode.value)
  if (panelError.value) {
    inputText.value = text
  }
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
}

watch(
  () => props.resource?.id,
  (newId, oldId) => {
    if (newId && oldId && newId !== oldId) {
      mode.value = 'chat'
      diffCache.clear()
      expandedDiffHeights.value = []
      expandedTraces.value = []
    }
  }
)

watch(isEditable, (editable) => {
  if (!editable) {
    mode.value = 'chat'
  }
})

watch(messages, scrollToBottom)
watch(isLoading, (loading) => {
  if (loading) {
    scrollToBottom()
  }
})

onMounted(() => {
  ensureReady()
})
</script>

<style scoped>
.chat-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 1rem;
}
.chat-messages {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 0.5rem;
}

.chat-placeholder {
  color: var(--oc-color-text-muted, #6f6f6f);
  font-style: italic;
  font-size: 0.875rem;
}

.chat-error {
  color: var(--oc-color-danger, #c00);
  font-size: 0.875rem;
}

.chat-truncation-note {
  font-size: 0.75rem;
  color: var(--oc-color-text-muted, #6f6f6f);
}

.chat-message--user {
  display: flex;
  justify-content: flex-end;
}

.chat-message--assistant {
  display: flex;
  justify-content: flex-start;
}

.chat-bubble {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 0.875rem;
}

.chat-bubble--user {
  background-color: var(--oc-color-swatch-primary-default, #0d6efd);
  color: #fff;
}

.chat-bubble--assistant {
  color: inherit;
}

.chat-bubble--loading {
  color: var(--oc-color-text-muted, #6f6f6f);
  font-style: italic;
  overflow-wrap: anywhere;
}

.loading-meta {
  opacity: 0.7;
  font-style: normal;
}

.chat-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: inherit;
}

/* Rendered Markdown (assistant answers) — compact typography, theme vars.
   The content comes from v-html, so child selectors need :deep() to escape
   the scoped-compiler's [data-v] attribute (v-html nodes don't carry it). */
.chat-content--md {
  white-space: normal;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.chat-content--md > :deep(:first-child) {
  margin-top: 0;
}
.chat-content--md > :deep(:last-child) {
  margin-bottom: 0;
}
.chat-content--md :deep(p) {
  margin: 0 0 0.5em;
}
.chat-content--md :deep(ul),
.chat-content--md :deep(ol) {
  margin: 0 0 0.5em;
  padding-left: 1.3em;
}
.chat-content--md :deep(li) {
  margin: 0.15em 0;
}
.chat-content--md :deep(code) {
  font-family: var(--oc-font-family-mono, monospace);
  font-size: 0.9em;
  background: var(--oc-color-background-muted, #f4f4f4);
  border-radius: 3px;
  padding: 1px 4px;
}
.chat-content--md :deep(pre) {
  background: var(--oc-color-background-muted, #f4f4f4);
  border: 1px solid var(--oc-color-input-border, #ccc);
  border-radius: 6px;
  padding: 8px 10px;
  overflow-x: auto;
  margin: 0 0 0.5em;
}
.chat-content--md :deep(pre code) {
  background: none;
  padding: 0;
}
.chat-content--md :deep(blockquote) {
  margin: 0.5em 0;
  padding-left: 10px;
  border-left: 3px solid var(--oc-color-input-border, #ccc);
  color: var(--oc-color-text-muted, #6f6f6f);
}
.chat-content--md :deep(h1),
.chat-content--md :deep(h2),
.chat-content--md :deep(h3),
.chat-content--md :deep(h4) {
  font-size: 1.02em;
  font-weight: 600;
  margin: 0.7em 0 0.3em;
}
.chat-content--md :deep(table) {
  border-collapse: collapse;
  margin: 0.5em 0;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}
.chat-content--md :deep(th),
.chat-content--md :deep(td) {
  border: 1px solid var(--oc-color-input-border, #ccc);
  padding: 3px 8px;
  font-size: 0.9em;
}
.chat-content--md :deep(a) {
  color: var(--oc-color-swatch-primary-default, #0d6efd);
  text-decoration: underline;
}
.chat-content--md :deep(hr) {
  border: none;
  border-top: 1px solid var(--oc-color-input-border, #ccc);
  margin: 0.6em 0;
}
.chat-content--md :deep(img) {
  max-width: 100%;
}

/* Copy / Save action row under assistant answers */
.chat-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 4px;
}
.chat-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--oc-color-text-muted, #6f6f6f);
  cursor: pointer;
  padding: 0;
}
.chat-action-btn:hover:not(:disabled) {
  background: var(--oc-color-background-muted, #f4f4f4);
  color: var(--oc-color-text-default, inherit);
}
.chat-action-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.chat-saved-label {
  font-size: 0.72rem;
  color: #1a7f37;
}

.chat-apply-row {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.diff-block {
  font-family: monospace;
  font-size: 0.78rem;
  border: 1px solid var(--oc-color-input-border, #ccc);
  border-radius: 4px;
  overflow-x: auto;
  max-height: 260px;
  overflow-y: auto;
}

.diff-block--tall {
  max-height: 600px;
}

.diff-height-toggle {
  display: block;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--oc-color-swatch-primary-default, #0d6efd);
  padding: 4px 0;
  text-align: center;
}

.diff-height-toggle:hover {
  text-decoration: underline;
}

.diff-line {
  display: block;
  white-space: pre;
  padding: 0 8px;
  line-height: 1.5;
  min-width: max-content;
}

.diff-line--added {
  background: #e6ffec;
  color: #1a7f37;
}

.diff-line--removed {
  background: #ffebe9;
  color: #cf222e;
}

.diff-line--unchanged {
  color: var(--oc-color-text-muted, #6f6f6f);
}

.diff-line--sep {
  background: #ddf4ff;
  color: #0550ae;
  padding: 1px 8px;
}

.diff-empty {
  font-size: 0.8rem;
  color: var(--oc-color-text-muted, #6f6f6f);
  font-style: italic;
}

.diff-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.78rem;
  font-family: inherit;
  color: var(--oc-color-text-muted, #6f6f6f);
  padding: 0;
  margin-bottom: 4px;
}

.diff-toggle:hover {
  color: var(--oc-color-text-default, inherit);
}

.diff-toggle-icon {
  font-size: 0.7rem;
}

/* Tool-trace (folder chat): which files the model accessed */
.trace-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.78rem;
  font-family: inherit;
  color: var(--oc-color-text-muted, #6f6f6f);
  padding: 0;
  margin-top: 6px;
}

.trace-toggle:hover {
  color: var(--oc-color-text-default, inherit);
}

.trace-list {
  margin-top: 4px;
  font-size: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.trace-entry {
  display: flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
}

.trace-tool {
  color: var(--oc-color-swatch-primary-default, #0d6efd);
  flex-shrink: 0;
}

.trace-path {
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trace-flag {
  font-style: italic;
  color: var(--oc-color-text-muted, #6f6f6f);
  flex-shrink: 0;
}

.trace-flag--warn {
  color: #9a6700;
}

.trace-flag--error {
  color: var(--oc-color-danger, #c00);
}

.trace-flag--method {
  font-style: normal;
  font-family: var(--oc-font-family-mono, monospace);
  font-size: 0.9em;
}

/* Unified input card */
.chat-input-card {
  border: 1px solid var(--oc-color-input-border, #ccc);
  border-radius: 10px;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}

.chat-input-card--focused {
  border-color: var(--oc-color-swatch-primary-default, #0d6efd);
  box-shadow: 0 0 0 2px
    color-mix(in srgb, var(--oc-color-swatch-primary-default, #0d6efd) 20%, transparent);
}

.chat-textarea {
  display: block;
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  padding: 10px 12px 6px;
  font-size: 0.875rem;
  font-family: inherit;
  background: transparent;
  color: var(--oc-color-text-default, inherit);
  box-sizing: border-box;
}

.chat-textarea:disabled {
  opacity: 0.6;
}

.chat-input-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
}

.mode-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 0.8rem;
  font-family: inherit;
  border: 1px solid var(--oc-color-input-border, #ccc);
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
  color: var(--oc-color-text-default, inherit);
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}

.mode-pill:hover:not(:disabled):not(.mode-pill--active) {
  background: var(--oc-color-background-muted, #f4f4f4);
}

.mode-pill--active {
  background: var(--oc-color-swatch-primary-default, #0d6efd);
  border-color: var(--oc-color-swatch-primary-default, #0d6efd);
  color: #fff;
  cursor: default;
}

.mode-pill:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Model selector (only visible with 2+ models) */
.model-select {
  width: 160px;
  flex-shrink: 0;
}
/* The select sits at the bottom of the sidebar: open the dropdown upwards,
   the default downward direction would clip the options below the viewport */
.model-select :deep(.vs__dropdown-menu) {
  top: auto;
  bottom: calc(100% + 2px);
}
.model-select :deep(.vs__actions) {
  padding: 0 2px;
  min-height: 28px;
}
.model-select :deep(.vs__selection),
.model-select :deep(.vs__selected) {
  font-size: 0.8rem;
  line-height: 1.4;
  /* keep the selected label on one line so the closed box keeps its 36px height */
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Send icon button */
.send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 50%;
  background: var(--oc-color-swatch-primary-default, #0d6efd);
  color: #fff;
  cursor: pointer;
  transition: opacity 0.15s;
  flex-shrink: 0;
  /* keep the send button on the right edge when the model select is hidden
     (single-model setups have fewer footer children) */
  margin-left: auto;
}

.send-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.send-btn:not(:disabled):hover {
  opacity: 0.85;
}
</style>
