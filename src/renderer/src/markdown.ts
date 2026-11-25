import type { ChatSource } from '../../main/research'
import { iconSvg } from './Icon.svelte'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Text is escaped before it's parsed, so the patterns below match `>` as `&gt;` and so on.
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const SETEXT = /^ {0,3}=+[ \t]*$/
const QUOTE = /^ {0,3}&gt; ?/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*)|$)/
const MATH = /^ {0,3}(\$\$|\\\[)(.*)$/
// A table's divider row, e.g. `| --- | :-: |`.
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
// A backslash before punctuation (or an escaped entity) keeps it literal.
const ESCAPE = /\\(&(?:amp|lt|gt|quot|#39);|[!-/:-@[-`{-~])/g
// Only web links are made clickable; they open in the app like any other.
const WEB_URL = /^https?:\/\//i
// A link destination, allowing balanced parentheses as in Wikipedia URLs.
const DEST = String.raw`((?:[^\s()]|\([^\s()]*\))+)`
const LINK = new RegExp(
  String.raw`(!?)\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(\s*(?:&lt;)?${DEST}(?:&gt;)?(?:\s+(?:&quot;.*?&quot;|&#39;.*?&#39;))?\s*\)`,
  'g'
)

function startsBlock(line: string): boolean {
  return [FENCE, HR, HEADING, QUOTE, ITEM, MATH].some((re) => re.test(line))
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim())
}

// Bare URLs end before trailing punctuation and any closing parenthesis they didn't open.
function trimUrl(url: string): string {
  for (;;) {
    const entity = url.match(/&(?:quot|#39|gt|lt);$/)
    if (entity) url = url.slice(0, -entity[0].length)
    else if (/[.,:;!?*_~]$/.test(url)) url = url.slice(0, -1)
    else if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1)
    else return url
  }
}

// Renders the Markdown chat models write: headings, paragraphs, emphasis, strikethrough, inline
// and fenced code, nested and task lists, tables, blockquotes, rules, links and math (shown as
// source). Raw HTML is shown as text. Citations like [1] become links to the matching source.
export function renderMarkdown(text: string, sources: ChatSource[] = []): string {
  // Finished pieces are swapped for placeholders so later patterns can't reach inside them.
  const stashed: string[] = []
  const stash = (html: string) => `\u0000${stashed.push(html) - 1}\u0000`

  const link = (url: string, label: string) => stash(`<a href="${url}" data-url="${url}">${label}</a>`)

  // `inLink` leaves out links, so a link's label can't hold another.
  const span = (t: string, inLink = false): string => {
    let s = t
      .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks, code: string) => {
        const inner = code.replace(/\n/g, ' ')
        return stash(`<code>${/^ .*[^ ].* $/.test(inner) ? inner.slice(1, -1) : inner}</code>`)
      })
      .replace(/(?<!\\)\$\$([\s\S]+?)\$\$/g, (_m, tex) => stash(`<span class="math">${tex.trim()}</span>`))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex) => stash(`<span class="math">${tex.trim()}</span>`))
      // Not prices: `$5 and $10` has a space before its second `$`, and `$5-$10` a digit after it.
      .replace(/(?<![\\\w$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\d$])/g, (_m, tex) => stash(`<span class="math">${tex}</span>`))
      .replace(ESCAPE, (_m, c) => stash(c))
      // Models often put <br> in table cells.
      .replace(/&lt;br\s*\/?&gt;/gi, () => stash('<br>'))

    if (!inLink) {
      s = s
        .replace(/&lt;(https?:\/\/[^\s]+?)&gt;/gi, (_m, url) => link(url, url))
        .replace(LINK, (_m, bang: string, label: string, url: string) => {
          if (!WEB_URL.test(url)) return bang ? label : span(label, true)
          // Images are shown as links rather than loaded into the chat.
          return link(url, bang ? label || url : span(label, true) || url)
        })
        .replace(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g, (m, refs: string) => {
          const nums = refs.split(/\s*,\s*/).flatMap((part) => {
            const [from, to] = part.split(/\s*[–-]\s*/).map(Number)
            return to && to >= from && to - from < 20 ? Array.from({ length: to - from + 1 }, (_, k) => from + k) : [from]
          })
          const links = nums.map((n) => {
            const source = sources.find((s) => s.n === n)
            return source
              ? `<a class="cite" href="${escapeHtml(source.url)}" data-url="${escapeHtml(source.url)}" title="${escapeHtml(source.title)}">${n}</a>`
              : null
          })
          return links.every(Boolean) ? stash(links.join('')) : m
        })
        .replace(/(^|[^\w/=])(https?:\/\/[^\s\u0000]+)/gi, (_m, before, raw: string) => {
          const url = trimUrl(raw)
          return before + link(url, url) + raw.slice(url.length)
        })
    }

    return s
      .replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__(?=\S)([\s\S]+?)(?<=\S)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<del>$1</del>')
      .replace(/(^|[^*\w])\*(?![\s*])([^*]+?)(?<!\s)\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?![\s_])([^_]+?)(?<!\s)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/[ \t]*\\?\n[ \t]*/g, '<br>')
  }

  const codeBlock = (code: string, lang: string) =>
    stash(
      `<div class="code-block"><div class="code-head">${lang ? `<span class="code-lang">${lang}</span>` : ''}` +
        `<button type="button" class="copy-code" title="Copy code" aria-label="Copy code">${iconSvg('copy')}</button></div>` +
        `<pre><code>${code}</code></pre></div>`
    )

  // Reads the list starting at `start` into `out`, returning the index of its last line.
  const list = (lines: string[], start: number, out: string[]): number => {
    const first = lines[start].match(ITEM)!
    const ordered = /\d/.test(first[2])
    const items: string[][] = []
    let loose = false
    let i = start
    for (;;) {
      const m = lines[i]?.match(ITEM)
      if (!m || /\d/.test(m[2]) !== ordered) break
      const indent = m[1].length
      // Where the item's text starts; lines indented that far (or nested items) belong to it.
      const spaces = m[3]?.length ?? 1
      const offset = indent + m[2].length + (spaces > 4 ? 1 : spaces)
      const body = [m[4] ?? '']
      let blank = false
      for (i++; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) {
          body.push('')
          blank = true
          continue
        }
        const lead = line.match(/^ */)![0].length
        if (lead > indent) body.push(line.slice(Math.min(lead, offset)))
        // A paragraph's next line may skip the indent.
        else if (!blank && !startsBlock(line)) body.push(line)
        else break
        // More of the item's own text after a blank line spaces its blocks apart; a nested list doesn't.
        if (blank && /^\S/.test(body.at(-1)!) && !ITEM.test(body.at(-1)!)) loose = true
        blank = false
      }
      while (body.length > 1 && !body.at(-1)!.trim()) body.pop()
      items.push(body)
      const next = lines[i]?.match(ITEM)
      if (!next || /\d/.test(next[2]) !== ordered) break
      if (blank) loose = true
    }

    const tag = ordered ? 'ol' : 'ul'
    const startAt = ordered ? parseInt(first[2], 10) : 1
    const lis = items.map((body) => {
      const task = body[0].match(/^\[([ xX])\][ \t]+/)
      if (!task) return `<li>${blocks(body, !loose)}</li>`
      body[0] = body[0].slice(task[0].length)
      const box = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}>`
      return `<li class="task">${box}<div>${blocks(body, !loose)}</div></li>`
    })
    out.push(`<${tag}${startAt !== 1 ? ` start="${startAt}"` : ''}>${lis.join('')}</${tag}>`)
    return i - 1
  }

  // `tight` leaves paragraphs unwrapped, for list items without blank lines between them.
  const blocks = (lines: string[], tight = false): string => {
    const out: string[] = []
    let paragraph: string[] = []

    const flush = () => {
      if (!paragraph.length) return
      const html = span(paragraph.join('\n'))
      out.push(tight ? html : `<p>${html}</p>`)
      paragraph = []
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) {
        flush()
        continue
      }
      if (paragraph.length && SETEXT.test(line)) {
        out.push(`<h1>${span(paragraph.join('\n'))}</h1>`)
        paragraph = []
        continue
      }
      const fence = line.match(FENCE)
      if (fence) {
        flush()
        const indent = line.match(/^ */)![0].length
        const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`)
        const code: string[] = []
        // An unclosed fence (mid-stream) runs to the end of the text.
        while (++i < lines.length && !close.test(lines[i])) code.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''))
        out.push(codeBlock(code.join('\n'), fence[2]))
        continue
      }
      const math = line.match(MATH)
      if (math) {
        flush()
        const end = math[1] === '$$' ? '$$' : '\\]'
        const tex = [math[2]]
        if (math[2].includes(end)) tex[0] = math[2].slice(0, math[2].indexOf(end))
        else {
          while (++i < lines.length && !lines[i].includes(end)) tex.push(lines[i])
          if (i < lines.length) tex.push(lines[i].slice(0, lines[i].indexOf(end)))
        }
        out.push(stash(`<div class="math-block">${tex.join('\n').trim()}</div>`))
        continue
      }
      if (HR.test(line)) {
        flush()
        out.push('<hr>')
        continue
      }
      const heading = line.match(HEADING)
      if (heading) {
        flush()
        const level = heading[1].length
        out.push(`<h${level}>${span(heading[2] ?? '')}</h${level}>`)
        continue
      }
      if (QUOTE.test(line)) {
        flush()
        const quoted: string[] = []
        for (; i < lines.length; i++) {
          if (QUOTE.test(lines[i])) quoted.push(lines[i].replace(QUOTE, ''))
          // A quoted paragraph's next line may leave out the `>`.
          else if (lines[i].trim() && quoted.at(-1)?.trim() && !startsBlock(lines[i])) quoted.push(lines[i])
          else break
        }
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
        const head = tableCells(line)
        const cell = (tag: string, c: string, n: number) =>
          `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ''}>${span(c)}</${tag}>`
        const rows: string[] = []
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
          const cells = tableCells(lines[i])
          rows.push(`<tr>${head.map((_, n) => cell('td', cells[n] ?? '', n)).join('')}</tr>`)
        }
        i--
        out.push(
          `<div class="table"><table><thead><tr>${head.map((c, n) => cell('th', c, n)).join('')}</tr></thead>` +
            `<tbody>${rows.join('')}</tbody></table></div>`
        )
        continue
      }
      const item = line.match(ITEM)
      // Inside a paragraph, only a list starting at 1 begins a list, so "2024. was…" stays text.
      if (item && !(paragraph.length && /^\d/.test(item[2]) && parseInt(item[2], 10) !== 1)) {
        flush()
        i = list(lines, i, out)
        continue
      }
      paragraph.push(line.trim())
    }
    flush()
    return out.join('')
  }

  // NUL marks placeholders, so it can't be allowed in the input. Leading tabs count as 4 spaces.
  const source = escapeHtml(text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n'))
  const html = blocks(source.split('\n').map((l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length))))

  // Stashed pieces can hold placeholders of their own, e.g. code inside a link label.
  const restore = (h: string): string => h.replace(/\u0000(\d+)\u0000/g, (_m, i) => restore(stashed[Number(i)]))
  return restore(html)
}
