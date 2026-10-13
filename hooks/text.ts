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

/**
 * A prompt the plugin submitted: the text it sent, the text that entered
 * once other plugins' prompt.submit hooks rewrote it (known when the
 * submission resolves), and whether the submission is still entering.
 */
export type SubmittedPrompt = { sent: string; entered: string | undefined; isEntering: boolean }

/**
 * The submitted prompt a starting turn belongs to: the oldest whose text, as
 * sent or as it entered, the turn's text holds (queued prompts merge into one
 * turn); else the oldest still entering, as a turn can start before its
 * submission resolves with the rewritten text.
 */
export function claim<P extends SubmittedPrompt>(prompts: readonly P[], turnText: string): P | undefined {
  const text = turnText.trim()
  const holds = (part: string | undefined) => part !== undefined && part !== '' && text.includes(part)

  return prompts.find(prompt => holds(prompt.entered) || holds(prompt.sent)) ?? prompts.find(prompt => prompt.isEntering)
}

/** A numeric setting as a positive number: anything else (NaN, 0, negative, text) is the fallback. */
export function tunable(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN

  return Number.isFinite(number) && number > 0 ? number : fallback
}

/** A session id safe in a path and in a regex: anything odd becomes `-`. */
export function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '-')
}

/** The tag in this session's children's argv: `live-voice-<session id>`. */
export function sessionTag(sessionId: string): string {
  return `live-voice-${safeSessionId(sessionId)}`
}

/**
 * The `pkill -f` pattern for one script's children of one session: the
 * script's name, then `--tag <tag>` as a whole word, so neither another
 * session's children nor a bare script path match.
 */
export function killPattern(script: 'listen.py' | 'speak.sh', tag: string): string {
  return `${script.replace('.', '\\.')} (.* )?--tag ${tag}( |$)`
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

/** A line of listen.py's stdout: a meter level (0..1) or an utterance's WAV path. */
export type ListenerLine = { kind: 'level'; value: number } | { kind: 'wav'; path: string }

const LEVEL_LINE = /^level\s+(\S+)$/

/** Reads one listener line; anything else (blank, malformed, a relative path) is undefined. */
export function parseListenerLine(line: string): ListenerLine | undefined {
  const text = line.trim()
  const level = LEVEL_LINE.exec(text)
  if (level !== null) {
    const value = Number(level[1])

    return Number.isFinite(value) && value >= 0 ? { kind: 'level', value: Math.min(1, value) } : undefined
  }

  return text.startsWith('/') ? { kind: 'wav', path: text } : undefined
}

const BLOCKS = '▁▂▃▄▅▆▇█'
const LOWEST = '▁'

/** Width of the band's meter, in cells. */
export const METER_WIDTH = 8

/** A level (clamped to 0..1) as one of eight block heights. */
export function levelGlyph(level: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0))

  return BLOCKS[Math.round(clamped * (BLOCKS.length - 1))] ?? LOWEST
}

/** The newest `width` levels as blocks, oldest left, padded with the lowest block. */
export function sparkline(levels: readonly number[], width = METER_WIDTH): string {
  const glyphs = levels.slice(-width).map(levelGlyph).join('')

  return LOWEST.repeat(Math.max(0, width - glyphs.length)) + glyphs
}

const WAVE = '▂▃▅▇▅▃▂▁'

/** Frame `tick` of the looping speaking wave: the wave shape rotated one cell per tick. */
export function wave(tick: number): string {
  const shift = ((Math.trunc(tick) % WAVE.length) + WAVE.length) % WAVE.length

  return WAVE.slice(shift) + WAVE.slice(0, shift)
}
