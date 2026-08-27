import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import type Token from 'markdown-it/lib/token.mjs'

let md: MarkdownIt | null = null

// Code blocks in one of these languages are rendered as a "fragment" with a
// preview button (the chat's PreviewOverlay renders the content live in a
// sandboxed iframe over the middle area).
const FRAGMENT_LANGUAGES = new Set(['html', 'htm', 'html5'])

function getMarkdownIt(): MarkdownIt {
  if (md) {
    return md
  }
  const parser = new MarkdownIt({
    // LLM output is untrusted: no raw HTML passthrough
    html: false,
    linkify: true,
    // single newlines (as typed by the model) become line breaks
    breaks: true
  })
  // Links must never navigate the host app (the extension runs inside it)
  const defaultLinkRule = parser.renderer.rules.link_open ?? (() => '')
  parser.renderer.rules.link_open = (tokens: Token[], idx: number, options: any, _env: any, self: any) => {
    const out = defaultLinkRule(tokens, idx, options, _env, self)
    return out
      .replace(/^(<a )/, '$1target="_blank" rel="noopener noreferrer" ')
  }
  // HTML code fences become fragments: a preview button plus the collapsible
  // code. The content travels base64-encoded in data-fragment so attribute
  // quoting can never break (quotes, </div> sequences, …).
  const defaultFenceRule = parser.renderer.rules.fence ?? (() => '')
  parser.renderer.rules.fence = (tokens: Token[], idx: number, options: any, _env: any, self: any) => {
    const token = tokens[idx]
    const lang = (token.info ?? '').trim().toLowerCase()
    if (!FRAGMENT_LANGUAGES.has(lang)) {
      return defaultFenceRule(tokens, idx, options, _env, self)
    }
    const content = token.content
    const encoded = btoa(unescape(encodeURIComponent(content)))
    return (
      `<div class="chat-fragment" data-fragment="${encoded}">` +
      '<div class="chat-fragment-header">' +
      `<button type="button" class="chat-fragment-btn" title="">` +
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
      'fill="currentColor" aria-hidden="true">' +
      '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>' +
      '<path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>' +
      '</svg>' +
      '<span class="chat-fragment-btn-label">preview</span>' +
      '</button>' +
      '</div>' +
      '<details class="chat-fragment-details">' +
      '<summary>show code</summary>' +
      `<pre><code>${parser.utils.escapeHtml(content)}</code></pre>` +
      '</details>' +
      '</div>'
    )
  }
  md = parser
  return md
}

/** Render untrusted LLM markdown as sanitized HTML for safe v-html use */
export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(getMarkdownIt().render(src))
}

/** Decode a base64 data-fragment attribute back to the original HTML source */
export function decodeFragment(encoded: string): string {
  return decodeURIComponent(escape(atob(encoded)))
}
