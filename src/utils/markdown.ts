import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import type Token from 'markdown-it/lib/token.mjs'

let md: MarkdownIt | null = null

function getMarkdownIt(): MarkdownIt {
  if (md) {
    return md
  }
  md = new MarkdownIt({
    // LLM output is untrusted: no raw HTML passthrough
    html: false,
    linkify: true,
    // single newlines (as typed by the model) become line breaks
    breaks: true
  })
  // Links must never navigate the host app (the extension runs inside it)
  const defaultLinkRule = md.renderer.rules.link_open ?? (() => '')
  md.renderer.rules.link_open = (tokens: Token[], idx: number, options: any, _env: any, self: any) => {
    const out = defaultLinkRule(tokens, idx, options, _env, self)
    return out
      .replace(/^(<a )/, '$1target="_blank" rel="noopener noreferrer" ')
  }
  return md
}

/** Render untrusted LLM markdown as sanitized HTML for safe v-html use */
export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(getMarkdownIt().render(src))
}
