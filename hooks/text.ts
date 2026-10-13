// Pure text helpers of the live-voice mod: command parsing, transcript
// filtering, markdown stripping and sentence chunking for speech.

import type { LiveVoiceAnimation, LiveVoiceColor, LiveVoiceColors } from '../types'

export const USAGE = 'Usage: /live [on|off|mute|status|voice <name>|config]'

/** What `/live config` can color, in the order the dialog lists them. */
export const COLOR_TARGETS = ['user', 'agent', 'dot', 'idle'] as const
export type ColorTarget = (typeof COLOR_TARGETS)[number]

/** The terminal's named colors the band offers. */
export const COLORS: readonly LiveVoiceColor[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray']

export const DEFAULT_COLORS: LiveVoiceColors = { user: 'green', agent: 'cyan', dot: 'red', idle: 'gray' }

/** How the band's wave moves: a bouncing line, bars, or not at all. */
export const ANIMATIONS: readonly LiveVoiceAnimation[] = ['wave', 'bars', 'off']

/** The end-of-speech silences `/live config` offers, in ms. */
export const SILENCES: readonly number[] = [1000, 1500, 2000, 2500, 3000]

export const CONFIG_USAGE =
  `Usage: /live config [reset | voice <name> | animation <${ANIMATIONS.join('|')}> | silence <${SILENCES.join('|')}>` +
  ` | <${COLOR_TARGETS.join('|')}> <${COLORS.join('|')}>]`

const isTarget = (value: string): value is ColorTarget => (COLOR_TARGETS as readonly string[]).includes(value)
const isColor = (value: unknown): value is LiveVoiceColor => typeof value === 'string' && (COLORS as readonly string[]).includes(value)

/** Colors read back from the store: each valid one kept, anything else its default. */
export function liveColors(value: unknown): LiveVoiceColors {
  const stored = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const colors = { ...DEFAULT_COLORS }
  for (const target of COLOR_TARGETS) {
    const color = stored[target]
    if (isColor(color)) colors[target] = color
  }

  return colors
}

/** The settings `/live config` keeps beside the colors, each under its own `$.store` key. */
export type LiveSettings = { voice: string; animation: LiveVoiceAnimation; silenceMs: number }

const isAnimation = (value: unknown): value is LiveVoiceAnimation =>
  typeof value === 'string' && (ANIMATIONS as readonly string[]).includes(value)
const isSilence = (value: unknown): value is number => typeof value === 'number' && SILENCES.includes(value)
const isVoice = (value: unknown): value is string => typeof value === 'string' && VOICE_NAME.test(value)

/** Settings read back from the store: each valid one kept, anything else its default. */
export function liveSettings(stored: Record<string, unknown>, defaults: LiveSettings): LiveSettings {
  return {
    voice: isVoice(stored.voice) ? stored.voice : defaults.voice,
    animation: isAnimation(stored.animation) ? stored.animation : defaults.animation,
    silenceMs: isSilence(stored.silenceMs) ? stored.silenceMs : defaults.silenceMs,
  }
}

/** Kokoro voice names, each once, in name order with the Spanish (`e`) ones first. */
export function sortVoices(voices: readonly string[]): string[] {
  const names = [...new Set(voices.filter(isVoice))].sort()

  return [...names.filter(name => name.startsWith('e')), ...names.filter(name => !name.startsWith('e'))]
}

/** The voices offered when Kokoro does not list its own: Spanish first, a few English ones. */
export const FALLBACK_VOICES: readonly string[] = ['ef_dora', 'em_alex', 'em_santa', 'af_heart', 'af_bella', 'am_adam', 'bf_emma', 'bm_george']

/** Said once per reply in place of its code blocks. */
export const CODE_OMITTED = 'código omitido'

export type LiveCommand =
  | { kind: 'toggle' }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'mute' }
  | { kind: 'status' }
  | { kind: 'voice'; voice: string }
  | { kind: 'config' }
  | { kind: 'config-reset' }
  | { kind: 'config-set'; target: ColorTarget; color: LiveVoiceColor }
  | { kind: 'config-voice'; voice: string }
  | { kind: 'config-animation'; animation: LiveVoiceAnimation }
  | { kind: 'config-silence'; silenceMs: number }
  | { kind: 'error'; message: string }

const VOICE_NAME = /^[a-z]{1,3}_[a-z0-9]+$/i

function parseConfig(rest: string[]): LiveCommand {
  const [first = '', second = '', ...extra] = rest.map(word => word.toLowerCase())
  if (rest.length === 0) return { kind: 'config' }
  if (first === 'reset' && rest.length === 1) return { kind: 'config-reset' }
  if (isTarget(first) && isColor(second) && extra.length === 0) return { kind: 'config-set', target: first, color: second }
  if (first === 'voice' && isVoice(second) && extra.length === 0) return { kind: 'config-voice', voice: second }
  if (first === 'animation' && isAnimation(second) && extra.length === 0) return { kind: 'config-animation', animation: second }
  const silenceMs = /^\d+$/.test(second) ? Number(second) : NaN
  if (first === 'silence' && isSilence(silenceMs) && extra.length === 0) return { kind: 'config-silence', silenceMs }

  return { kind: 'error', message: CONFIG_USAGE }
}

export function parseLiveCommand(args: string): LiveCommand {
  const [head = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const [voice] = rest

  switch (head.toLowerCase()) {
    case '':
      return { kind: 'toggle' }
    case 'on':
    case 'off':
    case 'mute':
    case 'status':
      return { kind: head.toLowerCase() as 'on' | 'off' | 'mute' | 'status' }
    case 'config':
      return parseConfig(rest)
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

/** A width in whole cells, never negative. */
const cells = (width: number) => Math.max(0, Math.trunc(Number.isFinite(width) ? width : 0))

/** A level (clamped to 0..1) as one of eight block heights. */
export function levelGlyph(level: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0))

  return BLOCKS[Math.round(clamped * (BLOCKS.length - 1))] ?? LOWEST
}

/** A row of the lowest block, exactly `width` cells: the meter at rest. */
export function flatRow(width: number): string {
  return LOWEST.repeat(cells(width))
}

/** A number clamped to 0..1, NaN and infinities read as 0. */
const unit = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))

// How much of a new mic level the shown level takes at once: most of a rise
// (the wave jumps with the voice), a little of a fall (it settles, no flicker).
const ATTACK = 0.6
const DECAY = 0.2

/** The shown mic level after hearing `level`: a fast attack and a slow decay. */
export function smoothLevel(shown: number, level: number): number {
  const from = unit(shown)
  const to = unit(level)

  return from + (to - from) * (to > from ? ATTACK : DECAY)
}

/** The smoothed mic level (0..1) at which the listening wave takes the person's voice as heard. */
export const SPEECH_GATE = 0.15

/**
 * Whether a smoothed mic level is a voice: at or over `SPEECH_GATE`, judged on
 * the level rounded to hundredths as the band's state publishes it, so the
 * timer and the band always agree.
 */
export function isVoiced(level: number): boolean {
  return Math.round(unit(level) * 100) / 100 >= SPEECH_GATE
}

// The bars' height at silence, as a share of their full height.
const RIPPLE = 0.12

/**
 * Frame `frame` of the listening bars, exactly `width` cells: a bar every
 * other cell, each jumping to its own height each frame, all scaled by the
 * mic level (0..1): a low ripple at silence, tall bars when loud.
 */
export function barsRow(frame: number, level: number, width: number): string {
  const size = cells(width)
  const amplitude = RIPPLE + (1 - RIPPLE) * unit(level)
  const step = Math.trunc(Number.isFinite(frame) ? frame : 0)
  let row = ''
  for (let cell = 0; cell < size; cell += 1) {
    if (cell % 2 === 1) {
      row += ' '
      continue
    }
    const noise = Math.sin(cell * 12.9898 + step * 78.233) * 43758.5453
    row += levelGlyph(amplitude * (0.35 + 0.65 * (noise - Math.floor(noise))))
  }

  return row
}

const WAVE = '▂▃▅▇▅▃▂▁'

/** Frame `tick` of the looping speaking wave: the wave shape rotated one cell per tick. */
export function wave(tick: number): string {
  const shift = ((Math.trunc(tick) % WAVE.length) + WAVE.length) % WAVE.length

  return WAVE.slice(shift) + WAVE.slice(0, shift)
}

/** Frame `tick` of the speaking wave tiled across exactly `width` cells. */
export function waveRow(tick: number, width: number): string {
  const size = cells(width)
  const frame = wave(tick)

  return frame.repeat(Math.ceil(size / frame.length)).slice(0, size)
}

/**
 * The cells a terminal gives text, erring wide: emoji and pictographs (and
 * a symbol an emoji variation selector follows) count two, the variation
 * selectors and joiners none, anything else one.
 */
export function cellWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) continue
    const isWide = code >= 0x1f000 || (code >= 0x2300 && code <= 0x23ff) || (code >= 0x2600 && code <= 0x27bf)
    width += isWide ? 2 : 1
  }

  return width
}

/**
 * The audio bar's wave width: the columns less its other parts, a gap after
 * each, and a margin for a terminal that draws an emoji wider than counted.
 */
export function audioBarWaveWidth(columns: number, parts: readonly string[], gap = 1, margin = 2): number {
  const used = parts.reduce((sum, part) => sum + cellWidth(part) + gap, 0)

  return cells(columns - used - margin)
}
