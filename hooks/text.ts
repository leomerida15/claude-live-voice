// Pure text helpers of the live-voice mod: command parsing, transcript
// filtering, markdown stripping and sentence chunking for speech.

import type { LiveVoiceAnimation, LiveVoiceColor, LiveVoiceColors, LiveVoiceNamedColor, LiveVoiceThemeColor } from '../types'

export const USAGE = 'Usage: /live [on|off|mute|status|voice <name>|config]'

/** What `/live config` can color, in the order the dialog lists them. */
export const COLOR_TARGETS = ['user', 'agent', 'dot', 'idle'] as const
export type ColorTarget = (typeof COLOR_TARGETS)[number]

/** The terminal's named colors the band offers. */
export const COLORS: readonly LiveVoiceNamedColor[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray']

/** The theme keys the band offers: each drawn in the person's theme. */
export const THEME_COLORS: readonly LiveVoiceThemeColor[] = [
  'claude', 'success', 'suggestion', 'warning', 'error', 'permission', 'planMode', 'ide', 'remember', 'inactive', 'subtle',
]

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * A color as the band takes it, or undefined: a theme key in any case (kept
 * as the theme spells it, `planMode`), a named color (lowercase), or `#rgb` /
 * `#rrggbb` (as lowercase `#rrggbb`).
 */
export function parseColor(value: unknown): LiveVoiceColor | undefined {
  if (typeof value !== 'string') return undefined
  const lower = value.toLowerCase()
  const theme = THEME_COLORS.find(key => key.toLowerCase() === lower)
  if (theme !== undefined) return theme
  const named = COLORS.find(name => name === lower)
  if (named !== undefined) return named
  if (!HEX.test(lower)) return undefined
  const digits = lower.slice(1)

  return `#${digits.length === 3 ? [...digits].map(digit => digit + digit).join('') : digits}`
}

/** A color's red, green and blue (0..255). */
export type Rgb = [number, number, number]

/** `#rrggbb` (or `#rgb`) as its three channels; anything else undefined. */
export function hexToRgb(hex: string): Rgb | undefined {
  const color = parseColor(hex)
  if (color === undefined || !color.startsWith('#')) return undefined

  return [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16)) as Rgb
}

const channel = (value: number) => Math.min(255, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)))

/** Three channels (each rounded and clamped to 0..255) as lowercase `#rrggbb`. */
export function rgbToHex(rgb: Rgb): `#${string}` {
  return `#${rgb.map(value => channel(value).toString(16).padStart(2, '0')).join('')}`
}

/** A channel moved by `delta`, clamped to 0..255. */
export function stepChannel(value: number, delta: number): number {
  return channel(value + delta)
}

/** A channel as a bar of `width` cells: `█` in proportion to the value (0..255), `░` for the rest. */
export function channelBar(value: number, width: number): string {
  const size = cells(width)
  const filled = Math.round((channel(value) / 255) * size)

  return '█'.repeat(filled) + '░'.repeat(size - filled)
}

// Where the R G B bars start for a named color: the usual RGB of each name.
const NAMED_RGB: Record<LiveVoiceNamedColor, `#${string}`> = {
  red: '#ff0000',
  green: '#00ff00',
  yellow: '#ffff00',
  blue: '#0000ff',
  magenta: '#ff00ff',
  cyan: '#00ffff',
  white: '#ffffff',
  gray: '#808080',
}

/**
 * Where the R G B bars start for a color: a hex itself, a named color's usual
 * RGB, mid gray for a theme key (its RGB is the person's theme's, unknown here).
 */
export function customBase(color: LiveVoiceColor): `#${string}` {
  const parsed = parseColor(color)
  if (parsed?.startsWith('#') === true) return parsed as `#${string}`

  return NAMED_RGB[parsed as LiveVoiceNamedColor] ?? '#808080'
}

export const DEFAULT_COLORS: LiveVoiceColors = { user: 'green', agent: 'cyan', dot: 'red', idle: 'gray' }

/** How the band's wave moves: a bouncing line, bars, or not at all. */
export const ANIMATIONS: readonly LiveVoiceAnimation[] = ['wave', 'bars', 'off']

/** The end-of-speech silences `/live config` offers, in ms. */
export const SILENCES: readonly number[] = [1000, 1500, 2000, 2500, 3000]

export const CONFIG_USAGE =
  `Usage: /live config [reset | test | voice <name> | animation <${ANIMATIONS.join('|')}> | silence <${SILENCES.join('|')}> | keys [apply] | mute <chord> | stop <chord>` +
  ` | <${COLOR_TARGETS.join('|')}> <color>]; a color is a theme color (${THEME_COLORS.join('|')}),` +
  ` a named color (${COLORS.join('|')}) or #rrggbb`

const isTarget = (value: string): value is ColorTarget => (COLOR_TARGETS as readonly string[]).includes(value)

/** Colors read back from the store: each valid one kept, anything else its default. */
export function liveColors(value: unknown): LiveVoiceColors {
  const stored = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const colors = { ...DEFAULT_COLORS }
  for (const target of COLOR_TARGETS) {
    const color = parseColor(stored[target])
    if (color !== undefined) colors[target] = color
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

/** A Kokoro voice as the dialog names it: its id, name, native language and gender. */
export type VoiceInfo = { id: string; name: string; language: string; gender: 'female' | 'male' | 'unknown' }

// A Kokoro voice id's first letter is the voice's native language.
const VOICE_LANGUAGES: Record<string, string> = {
  a: 'American English',
  b: 'British English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Brazilian Portuguese',
  z: 'Mandarin Chinese',
}
const OTHER_LANGUAGE = 'Other'

// The voice letters that speak a Whisper language, in the order they are listed.
const SESSION_VOICE_LETTERS: Record<string, readonly string[]> = {
  es: ['e'],
  en: ['a', 'b'],
  fr: ['f'],
  it: ['i'],
  pt: ['p'],
  ja: ['j'],
  zh: ['z'],
  hi: ['h'],
}

/**
 * A Kokoro voice id read as `<language><gender>_<name>` (`ef_dora`: Spanish,
 * female, Dora); a `v0` before the name is dropped, an unknown letter is
 * `Other` (language) or `unknown` (gender).
 */
export function describeVoice(id: string): VoiceInfo {
  const [prefix = '', ...rest] = id.split('_')
  const raw = rest.join('_').replace(/^v0/i, '')
  const name = raw === '' ? id : raw.charAt(0).toUpperCase() + raw.slice(1)
  const isCode = prefix.length === 2
  const language = (isCode ? VOICE_LANGUAGES[prefix.charAt(0).toLowerCase()] : undefined) ?? OTHER_LANGUAGE
  const letter = isCode ? prefix.charAt(1).toLowerCase() : ''
  const gender = letter === 'f' ? 'female' : letter === 'm' ? 'male' : 'unknown'

  return { id, name, language, gender }
}

/** A voice in one line: `Dora · Spanish · female (ef_dora)`. */
export function voiceLabel(id: string): string {
  const voice = describeVoice(id)

  return `${voice.name} · ${voice.language} · ${voice.gender} (${voice.id})`
}

/** A voice as a picker option, its language first: `Spanish — Dora (female)`. */
export function voiceOption(id: string): string {
  const voice = describeVoice(id)

  return `${voice.language} — ${voice.name} (${voice.gender})`
}

/**
 * Voices grouped by native language: the session language's groups first
 * (English: American, then British), then the rest by language name with
 * `Other` last; within a group, by name. Each voice once.
 */
export function groupVoices(ids: readonly string[], sessionLanguage: string): { language: string; voices: VoiceInfo[] }[] {
  const groups = new Map<string, VoiceInfo[]>()
  for (const id of new Set(ids)) {
    const voice = describeVoice(id)
    groups.set(voice.language, [...(groups.get(voice.language) ?? []), voice])
  }
  const first = (SESSION_VOICE_LETTERS[sessionLanguage.toLowerCase()] ?? []).map(letter => VOICE_LANGUAGES[letter] ?? '')
  const rank = (language: string) => {
    const at = first.indexOf(language)

    return at >= 0 ? at : language === OTHER_LANGUAGE ? first.length + 1 : first.length
  }

  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([language, voices]) => ({ language, voices: voices.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) }))
}

/** The most options the engine takes in one `Select` (it refuses the whole tree past it). */
export const MAX_SELECT_OPTIONS = 64

/** A Select's options held to what the engine takes: the first 64, in the order given. */
export function selectOptions<T>(options: readonly T[]): T[] {
  return options.slice(0, MAX_SELECT_OPTIONS)
}

/** A voice as an option under its language: `Dora (female)`. */
export function voiceChoice(id: string): string {
  const voice = describeVoice(id)

  return `${voice.name} (${voice.gender})`
}

/**
 * The settings dialog's two-step voice picker: the native languages present
 * (as `groupVoices` orders them), the language shown (`wanted` when present,
 * else the voice's own, else the first), and that language's voices, at most
 * 64. The voice itself is always listed.
 */
export function voicePicker(
  ids: readonly string[],
  voice: string,
  sessionLanguage: string,
  wanted?: string,
): { languages: string[]; language: string; voices: VoiceInfo[] } {
  const groups = groupVoices(ids.includes(voice) ? ids : [voice, ...ids], sessionLanguage)
  const languages = selectOptions(groups.map(group => group.language))
  const own = describeVoice(voice).language
  const language = [wanted, own, languages[0]].find(one => one !== undefined && languages.includes(one)) ?? own
  const voices = selectOptions(groups.find(group => group.language === language)?.voices ?? [])

  return { languages, language, voices }
}

const SAMPLES: Record<string, string> = { e: 'Hola, así suena esta voz.' }
const ENGLISH_SAMPLE = 'Hi, this is how this voice sounds.'

/** What "Test voice" says: a sentence in the voice's own language (Spanish), else English. */
export function sampleText(id: string): string {
  return SAMPLES[id.charAt(0).toLowerCase()] ?? ENGLISH_SAMPLE
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
  | { kind: 'config-test' }
  | { kind: 'config-set'; target: ColorTarget; color: LiveVoiceColor }
  | { kind: 'config-voice'; voice: string }
  | { kind: 'config-animation'; animation: LiveVoiceAnimation }
  | { kind: 'config-silence'; silenceMs: number }
  | { kind: 'config-keys' }
  | { kind: 'config-keys-apply' }
  | { kind: 'config-chord'; which: 'mute' | 'stop'; chord: string }
  | { kind: 'error'; message: string }

const VOICE_NAME = /^[a-z]{1,3}_[a-z0-9]+$/i

function parseConfig(rest: string[]): LiveCommand {
  const [first = '', second = '', ...extra] = rest.map(word => word.toLowerCase())
  const color = parseColor(rest[1])
  if (rest.length === 0) return { kind: 'config' }
  if (first === 'reset' && rest.length === 1) return { kind: 'config-reset' }
  if (first === 'test' && rest.length === 1) return { kind: 'config-test' }
  if (isTarget(first) && color !== undefined && extra.length === 0) return { kind: 'config-set', target: first, color }
  if (first === 'voice' && isVoice(second) && extra.length === 0) return { kind: 'config-voice', voice: second }
  if (first === 'animation' && isAnimation(second) && extra.length === 0) return { kind: 'config-animation', animation: second }
  const silenceMs = /^\d+$/.test(second) ? Number(second) : NaN
  if (first === 'silence' && isSilence(silenceMs) && extra.length === 0) return { kind: 'config-silence', silenceMs }
  if (first === 'keys' && rest.length === 1) return { kind: 'config-keys' }
  if (first === 'keys' && second === 'apply' && extra.length === 0) return { kind: 'config-keys-apply' }
  if ((first === 'mute' || first === 'stop') && rest.length === 2) {
    const checked = checkChord(rest[1] ?? '')

    return 'chord' in checked ? { kind: 'config-chord', which: first, chord: checked.chord } : { kind: 'error', message: `Usage: /live config ${first} <chord>; ${checked.error}.` }
  }

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

/**
 * The cells a terminal Select takes, erring wide: its label and a space, its
 * longest option (the label, else the value) and two for the painter's marks.
 */
export function selectWidth(label: string, options: readonly { value: string; label?: string }[]): number {
  const head = label === '' ? 0 : cellWidth(label) + 1
  const longest = options.reduce((most, option) => Math.max(most, cellWidth(option.label ?? option.value)), 0)

  return head + longest + 2
}

/**
 * Fields of these widths packed into rows, in order: each row takes the next
 * field while it fits in `columns` with `gap` cells between fields; a field
 * wider than `columns` gets a row of its own. Returns each row's field indexes.
 */
export function packRows(widths: readonly number[], columns: number, gap: number): number[][] {
  const rows: number[][] = []
  let used = 0
  widths.forEach((width, index) => {
    const row = rows.at(-1)
    if (row !== undefined && used + gap + width <= columns) {
      row.push(index)
      used += gap + width
      return
    }
    rows.push([index])
    used = width
  })

  return rows
}

// An R G B row besides its bar: the channel letter, the 3-digit value, the
// `q: −` and `w: +` buttons, and one cell between each of the five parts.
const CHANNEL_ROW_PARTS = 1 + 3 + 4 + 4 + 4

/** The cells an R G B bar gets in a row `columns` wide: what is left, 6 to 48. */
export function channelBarWidth(columns: number): number {
  return Math.min(48, Math.max(6, Math.trunc(columns) - CHANNEL_ROW_PARTS))
}

/** The band's two chords, as `~/.claude/keybindings.json` spells them (`meta+m`). */
export type Chords = { mute: string; stop: string }

/** The keybinding actions the band's Mute and Stop buttons borrow (inert in the engine). */
export const CHORD_ACTIONS: Readonly<Record<keyof Chords, string>> = { mute: 'permission:toggleDebug', stop: 'footer:dismiss' }

/** Alt+M and Alt+S: alt+space, the old suggestion, is often taken by the OS. */
export const DEFAULT_CHORDS: Chords = { mute: 'meta+m', stop: 'meta+s' }

/** The chords the settings dialog offers; any other goes through `/live config mute|stop <chord>`. */
export const SUGGESTED_CHORDS: readonly string[] = ['meta+m', 'meta+s', 'meta+space', 'meta+x', 'meta+q', 'ctrl+]', 'ctrl+\\']

const MODIFIERS: Record<string, 'ctrl' | 'meta' | 'shift'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'meta',
  opt: 'meta',
  option: 'meta',
  meta: 'meta',
  shift: 'shift',
}
const MODIFIER_ORDER = ['ctrl', 'meta', 'shift'] as const
const CHORD_KEY = /^(?:[a-z0-9]|space|f(?:[1-9]|1[0-2])|[`\-=[\]\\;',./])$/
// What Claude Code never hands a binding (Ctrl+C, D, M, [, I, H), what the
// terminal takes (Ctrl+Z), and the prefix of the engine's own ctrl+x chords.
const RESERVED_CHORDS: Record<string, string> = {
  'ctrl+c': 'reserved: interrupt',
  'ctrl+d': 'reserved: exit',
  'ctrl+m': 'reserved: it arrives as Enter',
  'ctrl+[': 'reserved: it arrives as Escape',
  'ctrl+i': 'reserved: it arrives as Tab',
  'ctrl+h': 'reserved: it arrives as Backspace',
  'ctrl+z': 'reserved: the terminal suspends Claude Code',
  'ctrl+x': 'taken: the prefix of Claude Code\'s ctrl+x chords',
}

/**
 * A chord the band can be bound to, normalized (`alt`, `opt`, `option` are
 * `meta`; modifiers ordered ctrl, meta, shift), or why it cannot: one or more
 * modifiers with ctrl or meta among them, then a letter, digit, `space`,
 * punctuation or f1-f12; never one of the reserved chords.
 */
export function checkChord(text: string): { chord: string } | { error: string } {
  const raw = text.trim().toLowerCase()
  const usage = 'a chord is modifiers then a key, such as alt+m or ctrl+]: ctrl, alt (meta) or shift, then a letter, digit, space, punctuation or f1-f12'
  if (raw === '' || /\s/.test(raw)) return { error: `"${text.trim()}" is not one chord: ${usage}` }
  const parts = raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+')
  const key = parts.pop() ?? ''
  const modifiers = new Set<string>()
  for (const part of parts) {
    const modifier = MODIFIERS[part]
    if (modifier === undefined || modifiers.has(modifier)) return { error: `"${text.trim()}": ${usage}` }
    modifiers.add(modifier)
  }
  if (!CHORD_KEY.test(key)) return { error: `"${text.trim()}": ${usage}` }
  if (!modifiers.has('ctrl') && !modifiers.has('meta')) {
    return { error: `"${text.trim()}" needs ctrl or alt: a bare or shifted key types into the prompt` }
  }
  const chord = [...MODIFIER_ORDER.filter(one => modifiers.has(one)), key].join('+')
  const reserved = RESERVED_CHORDS[chord]

  return reserved === undefined ? { chord } : { error: `${chord} is ${reserved}` }
}

/** A chord as the person reads it on Linux: `meta` is the Alt key. */
export function chordLabel(chord: string): string {
  return chord.replace(/(^|\+)meta(?=\+)/g, '$1alt')
}

/** The band's hint: `alt+m mute · alt+s stop`. */
export function chordsHint(chords: Chords): string {
  return `${chordLabel(chords.mute)} mute · ${chordLabel(chords.stop)} stop`
}

/** The chords kept in `$.store`: each valid one, the default for the rest; equal ones fall back. */
export function liveChords(stored: unknown): Chords {
  const kept = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  const pick = (which: keyof Chords) => {
    const value = kept[which]
    const checked = typeof value === 'string' ? checkChord(value) : undefined

    return checked !== undefined && 'chord' in checked ? checked.chord : DEFAULT_CHORDS[which]
  }
  const chords = { mute: pick('mute'), stop: pick('stop') }

  return chords.mute === chords.stop ? { ...DEFAULT_CHORDS } : chords
}

type BindingBlock = { context?: unknown; bindings?: unknown; [field: string]: unknown }

// The file's blocks, or why it is not a keybindings file.
function bindingBlocks(text: string): { file: Record<string, unknown>; blocks: BindingBlock[] } | { error: string } {
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    return { error: 'keybindings.json is not valid JSON; fix it by hand first (nothing was written)' }
  }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) {
    return { error: 'keybindings.json is not an object with a "bindings" array (nothing was written)' }
  }
  const record = file as Record<string, unknown>
  const blocks = record.bindings ?? []
  if (!Array.isArray(blocks)) return { error: 'keybindings.json "bindings" is not an array (nothing was written)' }

  return { file: record, blocks: blocks as BindingBlock[] }
}

const isMap = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The band's chords a keybindings file binds now (normalized), when it parses. */
export function readChords(text: string): Partial<Chords> {
  const parsed = bindingBlocks(text)
  if ('error' in parsed) return {}
  const found: Partial<Chords> = {}
  for (const block of parsed.blocks) {
    if (!isMap(block) || !isMap(block.bindings)) continue
    for (const [keys, action] of Object.entries(block.bindings)) {
      const which = (Object.keys(CHORD_ACTIONS) as (keyof Chords)[]).find(one => CHORD_ACTIONS[one] === action)
      const checked = checkChord(keys)
      if (which !== undefined) found[which] = 'chord' in checked ? checked.chord : keys
    }
  }

  return found
}

/**
 * A keybindings file (its text, or undefined when there is none) with the
 * band's chords: every binding to the two actions removed, in any context,
 * the chords added to the first `Global` block (one is appended when there is
 * none), everything else kept; pretty JSON. Refuses a file that does not
 * parse and a chord another action holds.
 */
export function applyChords(text: string | undefined, chords: Chords): { text: string } | { error: string } {
  const parsed = bindingBlocks(text ?? '{"bindings": []}')
  if ('error' in parsed) return parsed
  const ours = new Set(Object.values(CHORD_ACTIONS))
  const wanted = new Set(Object.values(chords))
  for (const block of parsed.blocks) {
    if (!isMap(block) || !isMap(block.bindings)) continue
    for (const [keys, action] of Object.entries(block.bindings)) {
      if (typeof action === 'string' && ours.has(action)) continue
      const checked = checkChord(keys)
      if ('chord' in checked && wanted.has(checked.chord) && action !== null) {
        return { error: `${chordLabel(checked.chord)} is already bound to ${String(action)} in ${String(block.context)} (nothing was written)` }
      }
    }
  }
  const blocks = parsed.blocks.map(block => {
    if (!isMap(block) || !isMap(block.bindings)) return block
    const kept = Object.fromEntries(Object.entries(block.bindings).filter(([, action]) => !(typeof action === 'string' && ours.has(action))))

    return { ...block, bindings: kept }
  })
  const global = blocks.find(block => isMap(block) && block.context === 'Global' && isMap(block.bindings))
  const added = { [chords.mute]: CHORD_ACTIONS.mute, [chords.stop]: CHORD_ACTIONS.stop }
  if (global === undefined) {
    blocks.push({ context: 'Global', bindings: added })
  } else {
    global.bindings = { ...(global.bindings as Record<string, unknown>), ...added }
  }

  return { text: `${JSON.stringify({ ...parsed.file, bindings: blocks }, null, 2)}\n` }
}
