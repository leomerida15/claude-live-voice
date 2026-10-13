// Pure text helpers of the live-voice mod: command parsing, transcript
// filtering, markdown stripping and sentence chunking for speech.

export const USAGE = 'Usage: /live [on|off|mute|status|voice <name>]'

/** Said once per reply in place of its code blocks. */
export const CODE_OMITTED = 'código omitido'

export type LiveCommand =
  | { kind: 'toggle' }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'mute' }
  | { kind: 'status' }
  | { kind: 'voice'; voice: string }
  | { kind: 'error'; message: string }

const VOICE_NAME = /^[a-z]{1,3}_[a-z0-9]+$/i

export function parseLiveCommand(args: string): LiveCommand {
  const [head = '', voice] = args.trim().split(/\s+/).filter(Boolean)

  switch (head.toLowerCase()) {
    case '':
      return { kind: 'toggle' }
    case 'on':
    case 'off':
    case 'mute':
    case 'status':
      return { kind: head.toLowerCase() as 'on' | 'off' | 'mute' | 'status' }
    case 'voice':
      return voice !== undefined && VOICE_NAME.test(voice)
        ? { kind: 'voice', voice }
        : { kind: 'error', message: 'Usage: /live voice <name>, for example ef_dora or em_alex.' }
    default:
      return { kind: 'error', message: USAGE }
  }
}

// Phrases Whisper is known to invent from silence or noise.
const HALLUCINATIONS = [
  /blank_audio/i,
  /subt[ií]tul/i,
  /amara\.org/i,
  /^¡?gracias por ver/i,
  /suscr[ií]bete/i,
  /^\*[^*]*\*$/,
]

/** The transcript worth sending as a prompt, or undefined for noise. */
export function cleanTranscript(text: string): string | undefined {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed === '' || /^[[(].*[\])]$/.test(trimmed)) {
    return undefined
  }
  if (HALLUCINATIONS.some(pattern => pattern.test(trimmed))) {
    return undefined
  }
  const letters = trimmed.match(/\p{L}/gu)?.length ?? 0

  return letters < 2 ? undefined : trimmed
}

/** One line of markdown as plain words a voice can read. */
export function stripMarkdown(line: string): string {
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
    return ''
  }
  let text = line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<?https?:\/\/\S+?>?(?=[\s).,;!?]*(\s|$))/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^(\s*>)+\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')

  if (/^\s*\|.*\|\s*$/.test(text)) {
    text = /^[\s|:-]+$/.test(text)
      ? ''
      : text
          .split('|')
          .map(cell => cell.trim())
          .filter(Boolean)
          .join(', ')
  }

  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const FENCE = /^\s*(```|~~~)/
const MAYBE_FENCE = /^\s*[`~]/
// A sentence ends at . ! ? or … after something other than a digit (so 3.5
// and "2." list numbers stay whole), followed by whitespace.
const SENTENCE_END = /[^\d\s][.!?…]+["')\]»]*(?=\s)/g
const SPEAKABLE = /[\p{L}\p{N}]/u

function speakable(sentence: string, out: string[]) {
  const plain = stripMarkdown(sentence)
  if (SPEAKABLE.test(plain)) {
    out.push(plain)
  }
}

/** Cuts text at sentence ends; `rest` is what follows the last one. */
function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  let from = 0
  for (const match of text.matchAll(SENTENCE_END)) {
    const to = (match.index ?? 0) + match[0].length
    sentences.push(text.slice(from, to).trim())
    from = to
  }

  return { sentences, rest: text.slice(from) }
}

/**
 * Turns a reply streamed in pieces into sentences to speak, as each one
 * completes. Code blocks are skipped; the first says CODE_OMITTED.
 */
export class SentenceChunker {
  private line = ''
  private isInCode = false
  private hasSaidCode = false

  push(text: string): string[] {
    const out: string[] = []
    this.line += text
    let newline = this.line.indexOf('\n')
    while (newline >= 0) {
      const whole = this.line.slice(0, newline)
      this.line = this.line.slice(newline + 1)
      this.endLine(whole, out)
      newline = this.line.indexOf('\n')
    }
    if (!this.isInCode && !MAYBE_FENCE.test(this.line)) {
      const { sentences, rest } = splitSentences(this.line)
      sentences.forEach(sentence => speakable(sentence, out))
      this.line = rest
    }

    return out
  }

  flush(): string[] {
    const out: string[] = []
    const rest = this.line
    this.line = ''
    if (!FENCE.test(rest)) {
      this.endLine(rest, out)
    }

    return out
  }

  private endLine(line: string, out: string[]) {
    if (FENCE.test(line)) {
      this.isInCode = !this.isInCode
      if (this.isInCode && !this.hasSaidCode) {
        this.hasSaidCode = true
        out.push(CODE_OMITTED)
      }
      return
    }
    if (this.isInCode) {
      return
    }
    const { sentences, rest } = splitSentences(line)
    sentences.forEach(sentence => speakable(sentence, out))
    speakable(rest, out)
  }
}
