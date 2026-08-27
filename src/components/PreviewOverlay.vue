<template>
  <div
    v-if="modelValue"
    class="preview-overlay"
    role="dialog"
    :aria-label="$pgettext('Preview overlay dialog label', 'Fragment preview')"
  >
    <div class="preview-overlay-header">
      <span class="preview-overlay-title">{{ title }}</span>
      <div class="preview-overlay-actions">
        <button
          class="preview-overlay-btn"
          :aria-label="$pgettext('Download fragment button label', 'Download fragment as file')"
          :title="$pgettext('Download fragment button label', 'Download fragment as file')"
          @click="download"
        >
          <!-- download -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"
            />
          </svg>
        </button>
        <button
          class="preview-overlay-btn"
          :aria-label="$pgettext('Close preview button label', 'Close preview')"
          :title="$pgettext('Close preview button label', 'Close preview')"
          @click="close"
        >
          <!-- close -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      </div>
    </div>
    <!-- sandbox="allow-scripts" without allow-same-origin: the rendered
         document cannot reach cookies, localStorage or the parent DOM -->
    <iframe
      ref="iframeEl"
      class="preview-overlay-frame"
      sandbox="allow-scripts"
      :srcdoc="modelValue"
    ></iframe>
    <div class="preview-overlay-footer">
      {{ $pgettext('Preview footer hint', 'Live preview — scripts run in a sandbox without access to your account.') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useGettext } from 'vue3-gettext'

const { $pgettext } = useGettext()

const props = defineProps<{
  /** The raw HTML to preview; empty/null = overlay closed */
  modelValue: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | null): void
}>()

const iframeEl = ref<HTMLIFrameElement | null>(null)

const title = computed(() => {
  const match = props.modelValue?.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const parsed = match?.[1]?.trim()
  return parsed || $pgettext('Preview fallback title', 'Preview')
})

function close(): void {
  emit('update:modelValue', null)
}

function download(): void {
  if (!props.modelValue) {
    return
  }
  const blob = new Blob([props.modelValue], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'vorschau.html'
  anchor.click()
  URL.revokeObjectURL(url)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    close()
  }
}

watch(
  () => props.modelValue,
  (value) => {
    if (value) {
      window.addEventListener('keydown', onKeydown)
    } else {
      window.removeEventListener('keydown', onKeydown)
    }
  },
  { immediate: true }
)

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.preview-overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  /* The file sidebar stays visible on the left (host default 400px) — the
     overlay fills only the middle area */
  left: 400px;
  z-index: calc(var(--oc-z-index-modal, 1000) + 100);
  background: var(--oc-color-surface-container, #fff);
  display: flex;
  flex-direction: column;
}

@media (max-width: 767px) {
  .preview-overlay {
    left: 0;
  }
}

.preview-overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--oc-color-input-border, #ccc);
}

.preview-overlay-title {
  font-weight: 600;
  font-size: 0.9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-overlay-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.preview-overlay-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--oc-color-text-muted, #6f6f6f);
  cursor: pointer;
  padding: 0;
}

.preview-overlay-btn:hover {
  background: var(--oc-color-background-muted, #f4f4f4);
  color: var(--oc-color-text-default, inherit);
}

.preview-overlay-frame {
  flex: 1;
  width: 100%;
  border: none;
  background: #fff;
}

.preview-overlay-footer {
  padding: 6px 12px;
  font-size: 0.72rem;
  color: var(--oc-color-text-muted, #6f6f6f);
  border-top: 1px solid var(--oc-color-input-border, #ccc);
}
</style>
