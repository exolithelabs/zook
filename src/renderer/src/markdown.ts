import type { ChatSource } from '../../main/index'
import { iconSvg } from './Icon.svelte'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Input is already escaped, so captured text and URLs are safe to place in markup.
function inline(text: string, sources: ChatSource[], stash: (html: string) => string): string {
  return text
    .replace(/`([^`\n]+)`/g, (_m, code) => stash(`<code>${code}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => stash(`<a href="${url}" data-url="${url}">${label}</a>`))
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, nums: string) => {
      const links = nums.split(/\s*,\s*/).map((n) => {
        const source = sources[Number(n) - 1]
        return source
          ? `<a class="cite" href="${escapeHtml(source.url)}" data-url="${escapeHtml(source.url)}" title="${escapeHtml(source.title)}">${n}</a>`
          : null
      })
      return links.every(Boolean) ? stash(links.join('')) : m
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
}

// A table's divider row, e.g. `| --- | :-: |`.
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

// Renders the small part of Markdown chat models use most: paragraphs, headings, bold,
// italics, inline code, fenced code blocks, lists, tables, blockquotes and links.
// Citations like [1] become links to the matching source.
export function renderMarkdown(text: string, sources: ChatSource[] = []): string {
  // Code and links are swapped for placeholders so later patterns can't reach inside them.
  const stashed: string[] = []
  const stash = (html: string) => `\u0000${stashed.push(html) - 1}\u0000`
  const span = (t: string) => inline(t, sources, stash)

  // Lines are already escaped, so `>` arrives as `&gt;`. Blockquotes render their lines the same way.
  const blocks = (lines: string[]): string => {
    const out: string[] = []
    let paragraph: string[] = []
    let list: { tag: 'ul' | 'ol'; items: string[] } | null = null

    const flush = () => {
      if (paragraph.length) out.push(`<p>${paragraph.map(span).join('<br>')}</p>`)
      paragraph = []
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${span(i)}</li>`).join('')}</${list.tag}>`)
      list = null
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const fence = line.match(/^\s*```\s*([\w+#.-]*)/)
      if (fence) {
        flush()
        const code: string[] = []
        // An unclosed fence (mid-stream) runs to the end of the text.
        while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i])
        const lang = fence[1] ? `<span class="code-lang">${fence[1]}</span>` : ''
        out.push(
          stash(
            `<div class="code-block"><div class="code-head">${lang}<button type="button" class="copy-code" title="Copy code" aria-label="Copy code">${iconSvg('copy')}</button></div>` +
              `<pre><code>${code.join('\n')}</code></pre></div>`
          )
        )
        continue
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/)
      if (heading) {
        flush()
        out.push(`<p class="heading">${span(heading[2])}</p>`)
        continue
      }
      if (/^\s*&gt;/.test(line)) {
        flush()
        const quoted: string[] = []
        for (; i < lines.length && /^\s*&gt;/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s*&gt; ?/, ''))
        i--
        out.push(`<blockquote>${blocks(quoted)}</blockquote>`)
        continue
      }
      // A header row only becomes a table once its divider row arrives.
      if (line.includes('|') && TABLE_DIVIDER.test(lines[i + 1] ?? '') && lines[i + 1].includes('-')) {
        flush()
        const align = tableCells(lines[i + 1]).map((c) =>
          c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''
        )
        const cell = (tag: string, c: string, n: number) =>
          `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ''}>${span(c)}</${tag}>`
        const head = tableCells(line).map((c, n) => cell('th', c, n)).join('')
        const rows: string[] = []
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
          rows.push(`<tr>${tableCells(lines[i]).map((c, n) => cell('td', c, n)).join('')}</tr>`)
        }
        i--
        out.push(`<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`)
        continue
      }
      const item = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/)
      if (item) {
        const tag = item[1] ? 'ul' : 'ol'
        if (paragraph.length || (list && list.tag !== tag)) flush()
        list ??= { tag, items: [] }
        list.items.push(item[3])
        continue
      }
      if (!line.trim()) {
        flush()
        continue
      }
      // An indented line right after a list item continues it.
      if (list && /^\s+\S/.test(line)) {
        list.items[list.items.length - 1] += ` ${line.trim()}`
        continue
      }
      if (list) flush()
      paragraph.push(line)
    }
    flush()
    return out.join('')
  }

  // NUL marks placeholders, so it can't be allowed in the input.
  const html = blocks(escapeHtml(text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n')).split('\n'))

  // Stashed pieces can hold placeholders of their own, e.g. code inside a link label.
  const restore = (h: string): string => h.replace(/\u0000(\d+)\u0000/g, (_m, i) => restore(stashed[Number(i)]))
  return restore(html)
}
