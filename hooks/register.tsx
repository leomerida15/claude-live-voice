import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type {
  LiveVoiceAnimation,
  LiveVoiceColor,
  LiveVoiceColors,
  LiveVoiceEditor,
  LiveVoiceEngine,
  LiveVoiceInterrupt,
  LiveVoiceSettings,
  LiveVoiceState,
  LiveVoiceStatus,
} from '../types'
import {
  ANIMATIONS,
  CHORD_ACTIONS,
  CODEX_VOICES,
  COLORS,
  CONFIG_USAGE,
  COLOR_TARGETS,
  DEFAULT_CHORDS,
  DEFAULT_CODEX_VOICE,
  DEFAULT_COLORS,
  ENGINES,
  FALLBACK_VOICES,
  INTERRUPTS,
  SILENCES,
  SUGGESTED_CHORDS,
  SentenceChunker,
  THEME_COLORS,
  USAGE,
  applyChords,
  bargeFlags,
  claim,
  codexCommandPath,
  codexControl,
  codexSettings,
  noticeCue,
  audioBarWaveWidth,
  barsRow,
  cellWidth,
  channelBar,
  channelBarWidth,
  chordLabel,
  chordsHint,
  cleanTranscript,
  customBase,
  flatRow,
  hexToRgb,
  isVoiced,
  killPattern,
  liveChords,
  liveColors,
  liveSettings,
  parseColor,
  parseListenerLine,
  parseSidecarEvent,
  readChords,
  parseLiveCommand,
  packRows,
  pauseMode,
  safeSessionId,
  sampleText,
  SPOKEN_ORIGINS,
  selectOptions,
  selectWidth,
  sessionTag,
  rgbToHex,
  smoothLevel,
  sortVoices,
  stepChannel,
  tunable,
  voiceLabel,
  voiceChoice,
  voicePicker,
  wave as waveFrame,
  waveRow,
  workStatus,
} from './text.ts'
import type { Chords, SidecarEvent, SubmittedPrompt } from './text.ts'

type $ = EngineInterface
type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

const OFF: LiveVoiceStatus = { isOn: false, state: 'off', queue: 0, voice: '', level: 0, wave: 0, dot: false }
const status = atom({ plugin: 'live-voice', key: 'status' } as const, OFF)
const colors = atom({ plugin: 'live-voice', key: 'colors' } as const, DEFAULT_COLORS)
const SETTINGS: LiveVoiceSettings = {
  voice: 'ef_dora',
  animation: 'wave',
  silenceMs: 2000,
  interrupt: 'speakers',
  engine: 'local',
  codexVoice: DEFAULT_CODEX_VOICE,
}
const settings = atom({ plugin: 'live-voice', key: 'settings' } as const, SETTINGS)
// The dialog's color editor: the color it changes and the channel step.
const COARSE = 16
const FINE = 1
const editor = atom({ plugin: 'live-voice', key: 'editor' } as const, { target: 'user', step: COARSE } as LiveVoiceEditor)

// The settings dialog's pane, and what each of its Selects is labelled.
const CONFIG_PANE = 'live-voice-config'
const COLOR_LABELS: Record<keyof LiveVoiceColors, string> = {
  user: 'You speaking   ',
  agent: 'Claude speaking',
  dot: 'Live dot       ',
  idle: 'Idle line      ',
}
// The dialog's color pickers, compact so four fit on a row of a wide dock.
const SHORT_COLOR_LABELS: Record<keyof LiveVoiceColors, string> = { user: 'You', agent: 'Claude', dot: 'Dot', idle: 'Idle' }
// The R G B bars: each channel's name, the color its bar is drawn in, and
// the hotkeys of its − and + buttons (unique in the pane: t tests the voice,
// 1 and 2 set the step).
const CHANNELS = [
  { key: 'red', label: 'R', color: '#ff0000', down: 'q', up: 'w' },
  { key: 'green', label: 'G', color: '#00ff00', down: 'a', up: 's' },
  { key: 'blue', label: 'B', color: '#0000ff', down: 'z', up: 'x' },
] as const
// The `$.store` keys of the settings kept beside `colors`.
const STORED = ['voice', 'animation', 'silenceMs', 'interrupt', 'engine', 'codexVoice'] as const

// The Codex engine: what `/live on` says when there is no sign-in, and the
// output level over which Claude's realtime voice counts as speaking.
const NOT_SIGNED_IN = 'Codex: not signed in, run /live-config codex login'
const OUTPUT_ACTIVE = 0.015

// A live turn of the Codex engine: the delegations it answers, the text of
// its last answering step, and whether a system message started it.
type CodexTurn = { delegations: string[]; pending: string; isNotice: boolean }

const STT_TIMEOUT_MS = 60_000
// The band's clock while live voice is on: the wave moves one frame a tick
// while listening or speaking (8 redraws a second), the live dot blinks every
// BLINK_TICKS ticks.
const TICK_MS = 125
const BLINK_TICKS = 4

// Runtime state of the loop. Children die with the module on a reload, so
// this living in the module (not in $.state) loses nothing that survives.
const live = {
  isOn: false,
  isMuted: false,
  isTranscribing: false,
  voice: 'ef_dora',
  listener: undefined as Child | undefined,
  player: undefined as Child | undefined,
  // The "Test voice" sample playing, live voice on or off.
  tester: undefined as Child | undefined,
  queue: [] as string[],
  isSpeaking: false,
  // The echo tail after a reply: the mic stays paused whatever `interrupt` says.
  isHeld: false,
  // The person spoke over the reply: it was cut, and no echo tail follows.
  isBarged: false,
  // How speaking over a reply interrupts it (also in the `settings` state).
  interrupt: 'speakers' as LiveVoiceInterrupt,
  // Transcripts this plugin submitted, not yet claimed by a turn.start.
  prompts: [] as SubmittedPrompt[],
  // Live turns by id, each with the chunker of its spoken reply.
  turns: new Map<string, SentenceChunker>(),
  // Live turns a system message started whose first sentence still waits
  // for the notice cue.
  cues: new Set<string>(),
  // The mic level (0..1) the listening wave shows: listen.py's levels,
  // smoothed (fast attack, slow decay); 0 unless listening.
  level: 0,
  // How the wave moves (also in the `settings` state, for the band).
  animation: 'wave' as LiveVoiceAnimation,
  // Kokoro's voices, as last listed for the settings dialog.
  voices: [...FALLBACK_VOICES],
  // The band's ticks, the wave's frame, the live dot, and the timer that
  // moves them while live voice is on.
  ticks: 0,
  waveTick: 0,
  dot: true,
  // Whether the wave moved on the last tick, so its stop is redrawn once.
  wasMoving: false,
  ticker: undefined as Timer | undefined,
  // The band's mute and stop chords (kept in $.store, bound in keybindings.json).
  chords: { ...DEFAULT_CHORDS } as Chords,
  // Who listens and speaks: local (listen.py, Whisper, Kokoro) or the Codex sidecar.
  engine: 'local' as LiveVoiceEngine,
  codexVoice: DEFAULT_CODEX_VOICE,
  // The Codex sidecar's `run`, whether its call is up, Claude's voice level in
  // it, the last command file's number, and its live turns by id.
  sidecar: undefined as Child | undefined,
  // Why the Codex sidecar last failed: its last `error` event or stderr line.
  sidecarReason: '',
  isReady: false,
  outLevel: 0,
  commandSeq: 0,
  codexTurns: new Map<string, CodexTurn>(),
  // Delegations already answered (`final`) or stopped (`cancel {id}`): the
  // server refuses anything more for them, so nothing more is sent.
  finishedDelegations: new Set<string>(),
  // The sidecar's `login`, while one runs.
  login: undefined as Child | undefined,
}

// Settings and paths, filled by register (options) and session.start (paths).
const config = {
  language: 'es',
  whisperUrl: 'http://127.0.0.1:2022/v1/audio/transcriptions',
  kokoroUrl: 'http://127.0.0.1:8880/v1/audio/speech',
  // Pause after playback before listening again, so the room's echo of the
  // last sentence is not taken for speech.
  echoTailMs: 350,
  // listen.py's VAD: silence that ends an utterance, loud frames that start
  // one, and how far over the noise floor speech must be.
  vadEndSilenceMs: 2000,
  vadStartFrames: 3,
  vadThresholdFactor: 3,
  scripts: '',
  // This session's tag, in every child's argv so a kill can find only them.
  tag: '',
  dir: '',
  pauseFile: '',
  sessionId: '',
  // Where the mod writes the Codex sidecar's commands, one JSON file each.
  codexDir: '',
}

// What `/live config reset` restores: the plugin's settings (`/config`), or
// the built-in defaults.
const defaults = { voice: 'ef_dora', silenceMs: 2000 }

// The Codex engine's state: its call setting up, Claude's voice playing, or the turn work.
const codexState = (): LiveVoiceState => {
  if (!live.isReady) return 'connecting'
  if (live.outLevel > OUTPUT_ACTIVE) return 'speaking'
  if (live.isMuted) return 'muted'
  if (live.prompts.length > 0 || live.codexTurns.size > 0) return 'thinking'
  return 'listening'
}

const stateNow = (): LiveVoiceState => {
  if (!live.isOn) return 'off'
  if (live.engine === 'codex') return codexState()
  if ((live.isSpeaking && !live.isBarged) || live.queue.length > 0) return 'speaking'
  if (live.isMuted) return 'muted'
  if (live.isTranscribing) return 'transcribing'
  if (live.prompts.length > 0 || live.turns.size > 0) return 'thinking'
  return 'listening'
}

const publish = ($: $) => {
  const state = stateNow()
  // A level heard before a pause (speech, mute, an utterance) is stale after it.
  if (state !== 'listening') live.level = 0

  return update($, status, () => ({
    isOn: live.isOn,
    state,
    queue: live.queue.length,
    voice: live.engine === 'codex' ? live.codexVoice : live.voice,
    level: Math.round(live.level * 100) / 100,
    wave: live.waveTick,
    dot: live.dot,
  }))
}

// Follows the mic level, only while listening: levels heard in any other
// state (muted, transcribing, thinking) would leak into the next wave. The
// band's timer draws it, so levels never redraw on their own.
const hearLevels = (levels: number[]) => {
  if (stateNow() !== 'listening') return
  for (const level of levels) live.level = smoothLevel(live.level, level)
}

// Whether the band's wave moves now: while speaking; while listening, the
// bars always (they follow the level) and the wave only while a voice is heard
// (silent, it is a still flat line).
const isWaveMoving = () => {
  const state = stateNow()
  if (live.animation === 'off') return false
  if (state === 'speaking') return true
  if (state !== 'listening') return false

  return live.animation === 'bars' || isVoiced(live.level)
}

// Moves the wave while it is moving (see isWaveMoving) and blinks the dot
// while not muted; redraws only when one of them changed, or when a heard
// voice falls silent (one last redraw, back to the flat line). One timer,
// started with live voice and stopped with it.
const startTicker = ($: $) => {
  stopTicker()
  live.ticks = 0
  live.dot = true
  live.wasMoving = false
  live.ticker = $.clock.every(TICK_MS, () => {
    live.ticks += 1
    const dot = Math.floor(live.ticks / BLINK_TICKS) % 2 === 0
    const hasBlinked = dot !== live.dot
    live.dot = dot
    const isMoving = isWaveMoving()
    const hasStopped = live.wasMoving && !isMoving
    live.wasMoving = isMoving
    if (isMoving) live.waveTick += 1
    if (isMoving || hasStopped || (hasBlinked && !live.isMuted)) void publish($).catch(() => undefined)
  })
}

const stopTicker = () => {
  live.ticker?.cancel()
  live.ticker = undefined
}

// The listener's mode (see pauseMode): "1" discards audio (muted, a voice
// sample, the echo tail, a reply with interrupt off), "2" listens for a
// barge-in while a reply plays, "0" listens.
const writePause = ($: $) =>
  $.fs.write(
    config.pauseFile,
    pauseMode({
      isMuted: live.isMuted,
      isSpeaking: live.isSpeaking || live.queue.length > 0,
      isHeld: live.isHeld || live.tester !== undefined,
      interrupt: live.interrupt,
    }),
  )

// Stops this session's children of one script (listen.py or speak.sh): the
// pattern needs the script name and this session's tag, so other sessions'
// children never match. The fallback for a child its stream did not stop.
const kill = ($: $, script: 'listen.py' | 'speak.sh' | 'codex-live/main.mjs') =>
  $.process
    .run(['pkill', '-TERM', '-f', '--', killPattern(script, config.tag)], { timeoutMs: 5_000 })
    .catch(() => undefined)

const forget = (prompt: SubmittedPrompt) => {
  live.prompts = live.prompts.filter(one => one !== prompt)
}

// Submits a transcript and keeps it as a live prompt until a turn claims it.
// The submission's result is the prompt as it entered (after other plugins'
// rewrites); the turn may start before it resolves, while it is entering.
// A plugin's own prompt.submit hooks do not see its own $.prompt.submit, so
// the record is kept here rather than in a hook.
const submit = ($: $, text: string, delegation?: string) => {
  const prompt: SubmittedPrompt = { sent: text, entered: undefined, isEntering: true, ...(delegation === undefined ? {} : { delegation }) }
  live.prompts.push(prompt)
  void $.prompt
    .submit({ text, asUser: true })
    .then(entered => {
      if (entered.drop !== undefined) forget(prompt)
      else prompt.entered = entered.text.trim()
    })
    .catch(() => forget(prompt))
    .finally(() => {
      prompt.isEntering = false
      void publish($)
    })
}

const transcribe = async ($: $, wav: string) => {
  if (!live.isOn || live.isMuted) {
    await $.process.run(['rm', '-f', wav]).catch(() => undefined)
    return
  }
  live.isTranscribing = true
  await publish($)
  try {
    const done = await $.process.run(
      ['curl', '-sf', '-F', `file=@${wav}`, '-F', 'model=whisper-1', '-F', `language=${config.language}`,
        '-F', 'response_format=json', config.whisperUrl],
      { timeoutMs: STT_TIMEOUT_MS },
    )
    const text = done.exitCode === 0 ? cleanTranscript(String(JSON.parse(done.stdout).text ?? '')) : undefined
    if (done.exitCode !== 0) $.ui.toast(`live-voice: Whisper is not answering at ${config.whisperUrl}`)
    if (text !== undefined && live.isOn && !live.isMuted) submit($, text)
  } catch {
    $.ui.toast('live-voice: transcription failed')
  } finally {
    live.isTranscribing = false
    await $.process.run(['rm', '-f', wav]).catch(() => undefined)
    await publish($)
  }
}

// Reads the listener's stdout, lines split across chunks: a WAV path per
// utterance, and mic levels (about 8 a second) for the listening wave.
const listen = async ($: $, child: Child) => {
  let pending = ''
  try {
    for await (const chunk of child) {
      if (chunk.stream !== 'stdout') continue
      pending += chunk.text
      let levels: number[] = []
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = parseListenerLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        if (line?.kind === 'level') {
          levels.push(line.value)
        } else if (line?.kind === 'barge') {
          await bargeIn($)
        } else if (line?.kind === 'wav') {
          await transcribe($, line.path)
          levels = []
        }
        newline = pending.indexOf('\n')
      }
      if (levels.length > 0) hearLevels(levels)
    }
  } catch {
    // The child was stopped or failed; handled below.
  }
  if (live.listener === child) {
    live.listener = undefined
    if (live.isOn) {
      $.ui.toast('live-voice: the microphone listener stopped; /live on to restart')
      await stop($)
    }
  }
}

const speakNext = async ($: $) => {
  if (live.isSpeaking) return
  live.isSpeaking = true
  live.waveTick = 0
  // A reply wins over a voice sample still playing: two voices never overlap.
  const tester = live.tester
  if (tester !== undefined) {
    live.tester = undefined
    void tester.return(undefined as never).catch(() => undefined)
    await kill($, 'speak.sh')
  }
  await writePause($)
  await publish($)
  while (live.isOn && live.queue.length > 0) {
    const sentence = live.queue.shift() ?? ''
    await publish($)
    const player = $.process.spawn({
      argv: ['bash', `${config.scripts}/speak.sh`, '--tag', config.tag, live.voice],
      env: { KOKORO_URL: config.kokoroUrl },
      input: sentence,
    })
    live.player = player
    try {
      // speak.sh prints only errors: keep them to say why a sentence failed.
      let errors = ''
      for await (const chunk of player) {
        if (chunk.stream === 'stderr' && errors.length < 2_000) errors += chunk.text
      }
      const ended = await player.result
      if (ended.code !== 0 && ended.signal === null && live.isOn) {
        const why = errors.split('\n').map(line => line.trim()).find(line => line !== '')
        $.ui.toast(
          why === undefined
            ? `live-voice: speech failed (is Kokoro running at ${config.kokoroUrl}?)`
            : `live-voice: speech failed: ${why}`,
        )
      }
    } catch {
      // Stopped mid-sentence.
    }
    live.player = undefined
  }
  // The room's echo of the last sentence is not speech; after a barge-in the
  // person is already talking, so no tail.
  if (!live.isBarged) {
    live.isHeld = true
    if (live.isOn) await writePause($)
    await $.clock.sleep(config.echoTailMs).catch(() => undefined)
  }
  live.isHeld = false
  live.isSpeaking = false
  live.isBarged = false
  if (live.isOn) await writePause($)
  await publish($)
}

const enqueue = ($: $, sentences: string[]) => {
  if (!live.isOn || sentences.length === 0) return
  live.queue.push(...sentences)
  if (live.isSpeaking) {
    void publish($)
  } else {
    $.clock.after(0, () => void speakNext($))
  }
}

// Queues a live turn's sentences; a system-triggered turn's first one is
// preceded by the notice cue, so it is not taken for an answer to the person.
const enqueueTurn = ($: $, turnId: string, sentences: string[]) => {
  if (sentences.length === 0) return
  if (!live.cues.delete(turnId)) return enqueue($, sentences)
  const [first, ...rest] = sentences
  enqueue($, [`${noticeCue(config.language)} ${first}`, ...rest])
}

const silence = async ($: $) => {
  live.queue = []
  const players = [live.player, live.tester].filter((one): one is Child => one !== undefined)
  live.player = undefined
  live.tester = undefined
  for (const player of players) void player.return(undefined as never).catch(() => undefined)
  if (players.length > 0) await kill($, 'speak.sh')
  await publish($)
}

// The person spoke over a reply (listen.py's `barge`, only while it listens
// in mode "2"): the voice is cut and its queue dropped, and the live turn
// still running is aborted, as Esc would. What they said follows as a WAV and
// is submitted as the next live prompt. Muted, interrupt off, or nothing being
// spoken: ignored. Typed turns are never in `live.turns`, so never aborted.
const bargeIn = async ($: $) => {
  if (!live.isOn || live.isMuted || live.interrupt === 'off') return
  if (!live.isSpeaking && live.queue.length === 0) return
  live.isBarged = true
  // Forgotten first, so the rest of their streamed reply is not queued again.
  const running = [...live.turns.keys()]
  live.turns.clear()
  live.cues.clear()
  await silence($)
  for (const turnId of running) {
    // Rejects when the turn already ended: nothing left to abort.
    await $.turn.abort({ turnId }).catch(() => undefined)
  }
  await publish($)
}

// Plays the voice sample to its end, then lets the mic listen again; a
// failure is toasted with speak.sh's first stderr line.
const playSample = async ($: $, tester: Child) => {
  let errors = ''
  try {
    for await (const chunk of tester) {
      if (chunk.stream === 'stderr' && errors.length < 2_000) errors += chunk.text
    }
    const ended = await tester.result
    if (ended.code !== 0 && ended.signal === null && live.tester === tester) {
      const why = errors.split('\n').map(line => line.trim()).find(line => line !== '')
      $.ui.toast(`live-voice: the voice test failed${why === undefined ? '' : `: ${why}`}`)
    }
  } catch {
    // Stopped mid-sample.
  }
  if (live.tester !== tester) return
  live.tester = undefined
  if (live.isOn) await writePause($)
}

// "Test voice": says a short sample in the selected voice, with this
// session's tag so a stop kills it; refused while a reply is being spoken or
// another sample plays, so two voices never overlap.
const testVoice = async ($: $) => {
  if (live.isSpeaking || live.queue.length > 0 || live.tester !== undefined) {
    return 'Live voice is busy speaking; test the voice when it is quiet.'
  }
  const tester = $.process.spawn({
    argv: ['bash', `${config.scripts}/speak.sh`, '--tag', config.tag, live.voice],
    env: { KOKORO_URL: config.kokoroUrl },
    input: sampleText(live.voice),
  })
  live.tester = tester
  if (live.isOn) await writePause($)
  $.clock.after(0, () => void playSample($, tester))

  return `Testing voice ${voiceLabel(live.voice)}.`
}

// listen.py's barge-in start for the current `interrupt` setting.
const listenerBargeFlags = () => {
  const flags = bargeFlags(live.interrupt, config.vadThresholdFactor, config.vadStartFrames)

  return ['--barge-ratio', String(flags.ratio), '--barge-frames', String(flags.frames)]
}

// Starts listen.py with the current VAD settings and reads it.
const spawnListener = ($: $) => {
  const child = $.process.spawn({
    argv: [
      'python3', '-I', `${config.scripts}/listen.py`,
      '--dir', config.dir, '--pause-file', config.pauseFile, '--tag', config.tag,
      '--end-silence-ms', String(config.vadEndSilenceMs),
      '--start-frames', String(config.vadStartFrames),
      '--threshold-factor', String(config.vadThresholdFactor),
      ...listenerBargeFlags(),
    ],
  })
  live.listener = child
  $.clock.after(0, () => void listen($, child))
}

const sidecarPath = () => `${config.scripts}/codex-live/main.mjs`

// Hands the sidecar one command: a numbered JSON file in its command
// directory (a spawned child's stdin closes after its input, so it cannot
// carry them). The sidecar reads the files in order and deletes them.
const sendCodex = async ($: $, command: Record<string, unknown>) => {
  if (live.sidecar === undefined) return
  const { type, id } = command
  if (typeof id === 'string' && (type === 'commentary' || type === 'final' || type === 'cancel')) {
    if (live.finishedDelegations.has(id)) return
    if (type !== 'commentary') live.finishedDelegations.add(id)
  }
  live.commandSeq += 1
  await $.fs
    .write(codexCommandPath(config.codexDir, live.commandSeq), JSON.stringify(command))
    .catch(() => $.ui.toast('live-voice: could not reach the Codex session'))
}

// The sidecar's sign-in state (`status`): signed-in, expired, signed-out,
// or undefined when it does not answer.
const codexStatus = async ($: $): Promise<{ status: string; expires?: string } | undefined> => {
  const done = await $.process.run(['node', sidecarPath(), 'status'], { timeoutMs: 10_000 }).catch(() => undefined)
  const line = done?.stdout.split('\n').find(one => one.trim() !== '') ?? ''
  try {
    const value: unknown = JSON.parse(line)
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
    return typeof record.status === 'string'
      ? { status: record.status, ...(typeof record.expires === 'string' ? { expires: record.expires } : {}) }
      : undefined
  } catch {
    return undefined
  }
}

// A voice request from the realtime model: a control answered here, or work
// submitted as a live prompt that remembers its delegation.
const onDelegation = async ($: $, id: string, text: string) => {
  const control = codexControl(text)
  if (control === 'status') {
    await sendCodex($, { type: 'final', id, text: workStatus(live.codexTurns.size, live.prompts.length) })
  } else if (control === 'cancel') {
    const running = [...live.codexTurns.keys()]
    for (const turnId of running) await $.turn.abort({ turnId }).catch(() => undefined)
    await sendCodex($, { type: 'final', id, text: running.length > 0 ? 'I stopped the current operation.' : "There isn't a foreground operation to stop." })
  } else {
    submit($, text, id)
  }
  await publish($)
}

const onSidecarEvent = async ($: $, event: SidecarEvent) => {
  switch (event.type) {
    case 'ready':
      live.isReady = true
      if (live.isMuted) await sendCodex($, { type: 'mute', on: true })
      await publish($)
      break
    case 'level': {
      const before = stateNow()
      live.outLevel = event.out
      hearLevels([event.in])
      if (stateNow() !== before) await publish($)
      break
    }
    case 'delegation':
      await onDelegation($, event.id, event.text)
      break
    case 'error':
      live.sidecarReason = event.message
      $.ui.toast(event.code === 'signed-out' ? NOT_SIGNED_IN : `live-voice: ${event.message}`)
      break
    default:
      break
  }
}

// Reads the sidecar's JSON lines, split across chunks; its end while live
// voice is on turns live voice off.
const readSidecar = async ($: $, child: Child) => {
  let pending = ''
  try {
    for await (const chunk of child) {
      if (chunk.stream === 'stderr') {
        const last = chunk.text.split('\n').map(one => one.trim()).filter(one => one !== '').at(-1)
        if (last !== undefined && live.sidecar === child) live.sidecarReason = last.slice(0, 200)
        continue
      }
      if (chunk.stream !== 'stdout') continue
      pending += chunk.text
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          value = undefined
        }
        const event = parseSidecarEvent(value)
        if (event !== undefined && live.sidecar === child) await onSidecarEvent($, event)
        newline = pending.indexOf('\n')
      }
    }
  } catch {
    // The child was stopped or failed; handled below.
  }
  if (live.sidecar === child) {
    live.sidecar = undefined
    if (live.isOn) {
      // Names the cause: this toast replaces the error's own.
      const reason = live.sidecarReason === '' ? '' : ` (${live.sidecarReason})`
      $.ui.toast(`live-voice: the Codex session ended${reason}; /live on to start it again`)
      await stop($)
    }
  }
}

// The Codex engine's start: refused (a toast, live voice stays off) without
// a sign-in; else the sidecar's `run` in place of listen.py.
const startCodex = async ($: $) => {
  const signIn = await codexStatus($)
  if (signIn?.status === 'signed-out') {
    $.ui.toast(NOT_SIGNED_IN)
    return false
  }
  live.isOn = true
  live.isMuted = false
  live.isReady = false
  live.outLevel = 0
  live.commandSeq = 0
  live.finishedDelegations.clear()
  live.sidecarReason = ''
  await $.process.run(['rm', '-rf', config.codexDir]).catch(() => undefined)
  await $.process.run(['mkdir', '-p', config.codexDir])
  startTicker($)
  const child = $.process.spawn({
    argv: [
      'node', sidecarPath(), 'run',
      '--tag', config.tag, '--commands', config.codexDir,
      '--voice', live.codexVoice, '--language', config.language, '--session-id', config.sessionId,
    ],
  })
  live.sidecar = child
  $.clock.after(0, () => void readSidecar($, child))
  await publish($)
  return true
}

// Starts live voice with the engine chosen; false when it could not start.
const start = async ($: $): Promise<boolean> => {
  if (live.isOn) return true
  if (live.engine === 'codex') return startCodex($)
  live.isOn = true
  live.isMuted = false
  await $.process.run(['mkdir', '-p', config.dir])
  await writePause($)
  startTicker($)
  spawnListener($)
  await publish($)
  return true
}

// Mutes or unmutes the mic: the pause file (local) or the sidecar (Codex).
const toggleMute = async ($: $) => {
  live.isMuted = !live.isMuted
  if (live.engine === 'codex') await sendCodex($, { type: 'mute', on: live.isMuted })
  else await writePause($)
  await publish($)
}

// The band's Stop: cuts the spoken reply (local) or asks the realtime voice to stop (Codex).
const stopVoice = async ($: $) => {
  if (live.engine === 'codex') await sendCodex($, { type: 'cancel' })
  else await silence($)
}

// Stops this session's listener and starts it again, so new VAD settings
// take: the old one is let go first, so its end is not taken for a failure.
const restartListener = async ($: $) => {
  const listener = live.listener
  if (!live.isOn || listener === undefined) return
  live.listener = undefined
  void listener.return(undefined as never).catch(() => undefined)
  await kill($, 'listen.py')
  if (live.isOn) spawnListener($)
}

// Lets go of the children this module held (a reload's are orphans by now)
// and starts its runtime state over.
const forgetChildren = () => {
  for (const child of [live.listener, live.player, live.tester, live.sidecar]) {
    void child?.return(undefined as never).catch(() => undefined)
  }
  live.isOn = false
  live.isMuted = false
  live.isTranscribing = false
  live.listener = undefined
  live.player = undefined
  live.tester = undefined
  live.queue = []
  live.isSpeaking = false
  live.isHeld = false
  live.isBarged = false
  live.prompts = []
  live.turns.clear()
  live.cues.clear()
  live.level = 0
  live.sidecar = undefined
  live.isReady = false
  live.outLevel = 0
  live.codexTurns.clear()
  stopTicker()
}

// After session.start: kills this session's orphaned children, then, when
// live voice was on before a reload, listens again (muted if it was).
const recover = async ($: $, was: LiveVoiceStatus) => {
  await kill($, 'listen.py')
  await kill($, 'speak.sh')
  // A sidecar runs only with the Codex engine: changing the engine stops it first.
  if (live.engine === 'codex') await kill($, 'codex-live/main.mjs')
  if (!was.isOn) return
  if (!(await start($))) return
  if (was.state === 'muted') {
    live.isMuted = true
    if (live.engine === 'codex') await sendCodex($, { type: 'mute', on: true })
    else await writePause($)
    await publish($)
  }
}

const stop = async ($: $) => {
  live.isOn = false
  stopTicker()
  live.prompts = []
  live.turns.clear()
  live.cues.clear()
  live.codexTurns.clear()
  live.isReady = false
  live.outLevel = 0
  const sidecar = live.sidecar
  live.sidecar = undefined
  if (sidecar !== undefined) {
    // SIGTERM: the sidecar closes the call before it exits.
    void sidecar.return(undefined as never).catch(() => undefined)
    await kill($, 'codex-live/main.mjs')
  }
  const listener = live.listener
  live.listener = undefined
  if (listener !== undefined) {
    void listener.return(undefined as never).catch(() => undefined)
    await kill($, 'listen.py')
  }
  await silence($)
}

// Shows new colors at once and keeps them for later sessions.
const setColors = async ($: $, next: LiveVoiceColors) => {
  await update($, colors, () => next)
  await $.store.set('colors', next).catch(() => $.ui.toast('live-voice: could not save the colors'))
}

// A pick in the colors dialog: over the colors as they are now, not as drawn.
const pickColor = async ($: $, target: keyof LiveVoiceColors, color: LiveVoiceColor) =>
  setColors($, { ...liveColors(await read($, colors)), [target]: color })

// One − or + press on an R G B bar: the edited color, from where its bars
// start (customBase), moved one step on that channel, set and kept at once.
const nudgeChannel = async ($: $, channel: 0 | 1 | 2, sign: 1 | -1) => {
  const { target, step } = await read($, editor)
  const now = liveColors(await read($, colors))
  const rgb = hexToRgb(customBase(now[target])) ?? [128, 128, 128]
  rgb[channel] = stepChannel(rgb[channel], sign * step)
  await pickColor($, target, rgbToHex(rgb))
}

const setEditor = ($: $, change: Partial<LiveVoiceEditor>) => update($, editor, now => ({ ...now, ...change }))

// The voice picker follows the current voice again (a new voice, a newly opened dialog).
const followVoice = ($: $) => update($, editor, ({ voiceLanguage: _, ...now }) => now)

// Keeps one setting for later sessions; a failed write says so.
const keep = async ($: $, key: (typeof STORED)[number], value: unknown) =>
  $.store.set(key, value).catch(() => $.ui.toast(`live-voice: could not save the ${key}`))

// Shows the settings as they are now, to the band and the dialog.
const showSettings = ($: $) =>
  update($, settings, () => ({
    voice: live.voice,
    animation: live.animation,
    silenceMs: config.vadEndSilenceMs,
    interrupt: live.interrupt,
    engine: live.engine,
    codexVoice: live.codexVoice,
  }))

// A new engine takes at once: live voice, when on, stops and starts again with it.
const setEngine = async ($: $, engine: LiveVoiceEngine) => {
  if (engine === live.engine) return
  const wasOn = live.isOn
  if (wasOn) await stop($)
  live.engine = engine
  await showSettings($)
  await keep($, 'engine', engine)
  await publish($)
  if (wasOn) await start($)
}

// A new Codex voice takes on the next call: a running one starts again.
const setCodexVoice = async ($: $, voice: string) => {
  const isNew = voice !== live.codexVoice
  live.codexVoice = voice
  await showSettings($)
  await keep($, 'codexVoice', voice)
  await publish($)
  if (isNew && live.isOn && live.engine === 'codex') {
    await stop($)
    await start($)
  }
}

// Reads the sidecar's `login` lines into toasts; one login at a time.
const readLogin = async ($: $, child: Child) => {
  let pending = ''
  const say = (line: string) => {
    let value: Record<string, unknown>
    try {
      value = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : '')
    if (value.type === 'url') $.ui.toast(`Codex: if the browser did not open, visit ${text('url')}`)
    else if (value.type === 'device') $.ui.toast(`Codex: open ${text('url')} and enter the code ${text('code')}`)
    else if (value.type === 'progress' || value.type === 'done') $.ui.toast(`Codex: ${text('message')}`)
    else if (value.type === 'error') $.ui.toast(`Codex: sign-in failed: ${text('message')}`)
  }
  try {
    for await (const chunk of child) {
      if (chunk.stream !== 'stdout') continue
      pending += chunk.text
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        say(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    }
  } catch {
    // Stopped.
  }
  if (live.login === child) live.login = undefined
}

// `/live-config codex login|logout|status`.
const codexAccount = async ($: $, action: 'login' | 'logout' | 'status') => {
  if (action === 'login') {
    if (live.login !== undefined) return 'Codex sign-in is already running; finish it in the browser.'
    const child = $.process.spawn({ argv: ['node', sidecarPath(), 'login'] })
    live.login = child
    $.clock.after(0, () => void readLogin($, child))
    return 'Codex sign-in started in the browser; progress shows as toasts.'
  }
  if (action === 'logout') {
    const done = await $.process.run(['node', sidecarPath(), 'logout'], { timeoutMs: 10_000 }).catch(() => undefined)
    return done?.exitCode === 0 ? 'Codex: signed out.' : 'Codex: could not sign out (is node installed?).'
  }
  const now = await codexStatus($)
  if (now?.status === 'signed-in') return `Codex: signed in${now.expires === undefined ? '' : ` (token valid until ${now.expires}, refreshed by itself)`}.`
  if (now?.status === 'expired') return 'Codex: signed in; the token expired and is refreshed on the next /live on.'
  if (now?.status === 'signed-out') return 'Codex: signed out. Sign in with /live-config codex login.'
  return 'Codex: could not read the sign-in state (is node installed?).'
}

const setVoice = async ($: $, voice: string) => {
  live.voice = voice
  await followVoice($)
  await publish($)
  await showSettings($)
  await keep($, 'voice', voice)
}

const setAnimation = async ($: $, animation: LiveVoiceAnimation) => {
  live.animation = animation
  await showSettings($)
  await keep($, 'animation', animation)
}

// A new end-of-speech silence restarts the listener when it is running.
const setSilence = async ($: $, silenceMs: number) => {
  const isNew = silenceMs !== config.vadEndSilenceMs
  config.vadEndSilenceMs = silenceMs
  await showSettings($)
  await keep($, 'silenceMs', silenceMs)
  if (isNew) await restartListener($)
}

// A new interrupt mode takes at once: the pause file now, and the listener
// restarted when its barge-in start changed.
const setInterrupt = async ($: $, interrupt: LiveVoiceInterrupt) => {
  const before = listenerBargeFlags().join(' ')
  live.interrupt = interrupt
  await showSettings($)
  await keep($, 'interrupt', interrupt)
  if (live.isOn) await writePause($)
  if (listenerBargeFlags().join(' ') !== before) await restartListener($)
}

// Back to the plugin's settings and the default colors; nothing kept.
const resetSettings = async ($: $) => {
  // Back to the local engine: a Codex call stops, and live voice starts again locally.
  const wasCodexOn = live.isOn && live.engine === 'codex'
  if (wasCodexOn) await stop($)
  live.engine = SETTINGS.engine
  live.codexVoice = SETTINGS.codexVoice
  await setColors($, DEFAULT_COLORS)
  live.voice = defaults.voice
  live.animation = 'wave'
  const bargeBefore = listenerBargeFlags().join(' ')
  live.interrupt = SETTINGS.interrupt
  if (live.isOn) await writePause($)
  const isNew = config.vadEndSilenceMs !== defaults.silenceMs || listenerBargeFlags().join(' ') !== bargeBefore
  config.vadEndSilenceMs = defaults.silenceMs
  await showSettings($)
  await Promise.all(STORED.map(key => $.store.delete(key).catch(() => undefined)))
  await publish($)
  if (wasCodexOn) await start($)
  else if (isNew) await restartListener($)
}

// Kokoro's own voice list (Spanish first), or the built-in one when it does not answer.
const loadVoices = async ($: $) => {
  const url = config.kokoroUrl.replace(/\/audio\/speech\/?$/, '/audio/voices')
  const done = await $.process.run(['curl', '-sf', '--max-time', '3', url], { timeoutMs: 5_000 }).catch(() => undefined)
  let listed: string[] = []
  try {
    const voices: unknown = done?.exitCode === 0 ? JSON.parse(done.stdout).voices : undefined
    listed = Array.isArray(voices) ? sortVoices(voices.filter((one): one is string => typeof one === 'string')) : []
  } catch {
    listed = []
  }
  live.voices = listed.length > 0 ? listed : [...FALLBACK_VOICES]
}

// Every setting and how to change it: the answer of `/live config` when the
// dialog cannot be shown, and a reminder when it is.
const summary = async ($: $) => {
  const now = liveColors(await read($, colors))

  return [
    'Live voice settings:',
    `  voice      ${voiceLabel(live.voice)}`,
    `  animation  ${live.animation}`,
    `  silence    ${config.vadEndSilenceMs} ms`,
    `  interrupt  ${live.interrupt}`,
    `  engine     ${live.engine}`,
    `  codex voice ${live.codexVoice}`,
    `  colors     ${COLOR_TARGETS.map(target => `${target} ${now[target]}`).join(' · ')}`,
    'Change one with /live config voice <name>, or:',
    CONFIG_USAGE,
  ].join('\n')
}

const describe = () => {
  const engine = ` Engine ${live.engine}.`
  if (!live.isOn) return `Live voice is off. Voice ${live.engine === 'codex' ? live.codexVoice : live.voice}.${engine}`
  if (live.engine === 'codex') return `Live voice is on: ${stateNow()}, voice ${live.codexVoice}.${engine}`

  return `Live voice is on: ${stateNow()}, voice ${live.voice}, ${live.queue.length} sentence(s) queued.${engine}`
}

// What `/live on` answers once live voice started.
const onText = () =>
  live.engine === 'codex' ? `Live voice on (Codex). Speak; voice ${live.codexVoice}.` : `Live voice on. Speak; voice ${live.voice}.`


// A mod cannot name keybinding actions of its own, so the band borrows two the
// engine does not act on: a chord the person binds to one in
// ~/.claude/keybindings.json presses the button from the prompt.
const MUTE_ACTION = CHORD_ACTIONS.mute
const STOP_ACTION = CHORD_ACTIONS.stop

// The audio bar's separator before the wave and the narrowest wave worth drawing.
const BAR = '│'
const MIN_WAVE = 4

// Where Claude Code reads the person's chords, and the copy kept before a change.
const keybindingsPath = async ($: $) => {
  const home = await $.env.get('HOME')

  return home === undefined || home === '' ? undefined : `${home}/.claude/keybindings.json`
}

// The keybindings file's text, undefined when there is none, or why it could not be read.
const readKeybindings = async ($: $, path: string): Promise<{ text: string | undefined } | { error: string }> => {
  if (!(await $.fs.exists(path).catch(() => false))) return { text: undefined }
  try {
    return { text: await $.fs.read(path) }
  } catch (error) {
    return { error: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

// Binds the band's chords in keybindings.json (only the two actions it
// borrows; the rest of the file is kept, the old one backed up), then keeps
// them. Answers what happened; an error writes nothing.
const setChords = async ($: $, chords: Chords): Promise<string> => {
  if (chords.mute === chords.stop) return `Mute and stop must differ (both ${chordLabel(chords.mute)}).`
  const path = await keybindingsPath($)
  if (path === undefined) return 'Could not find HOME, so keybindings.json was not changed.'
  const before = await readKeybindings($, path)
  if ('error' in before) return `Could not change the shortcuts: ${before.error}.`
  const after = applyChords(before.text, chords)
  if ('error' in after) return `Could not change the shortcuts: ${after.error}.`
  try {
    if (before.text !== undefined) await $.fs.write(`${path}.live-voice.bak`, before.text)
    await $.fs.write(path, after.text)
  } catch (error) {
    return `Could not write ${path}: ${error instanceof Error ? error.message : String(error)}.`
  }
  live.chords = chords
  await $.store.set('chords', chords).catch(() => $.ui.toast('live-voice: could not save the shortcuts'))
  $.ui.invalidate('ui.render')

  return `Shortcuts set: ${chordsHint(chords)} (in ${path}).`
}

// The chords in use and what keybindings.json binds now.
const describeKeys = async ($: $) => {
  const path = await keybindingsPath($)
  const file = path === undefined ? { error: 'no HOME' } : await readKeybindings($, path)
  const bound = 'text' in file && file.text !== undefined ? readChords(file.text) : {}
  const inFile = (which: keyof Chords) => (bound[which] === undefined ? 'not bound' : chordLabel(bound[which]))

  return [
    `Shortcuts: ${chordsHint(live.chords)}.`,
    `In keybindings.json: mute ${inFile('mute')}, stop ${inFile('stop')}.`,
    'Change one with /live config mute <chord> or stop <chord> (alt+m, ctrl+], ...); /live config keys apply writes these.',
  ].join('\n')
}

// Answers `/live <args>`; `/live-config <args>` is `/live config <args>`, as a
// command name cannot hold a colon.
const answerLive = async ($: $, args: string) => {
  const command = parseLiveCommand(args)
  switch (command.kind) {
    case 'toggle':
      if (live.isOn) {
        await stop($)
        return { text: 'Live voice off.' }
      }
      return { text: (await start($)) ? onText() : NOT_SIGNED_IN }
    case 'on':
      return { text: (await start($)) ? onText() : NOT_SIGNED_IN }
    case 'off':
      await stop($)
      return { text: 'Live voice off.' }
    case 'mute':
      if (!live.isOn) return { text: 'Live voice is off.' }
      await toggleMute($)
      return { text: live.isMuted ? 'Microphone muted.' : 'Microphone unmuted.' }
    case 'status':
      return { text: describe() }
    case 'voice':
    case 'config-voice':
      await setVoice($, command.voice)
      return { text: `Voice set to ${command.voice}.` }
    case 'config': {
      await loadVoices($)
      await followVoice($)
      // A dialog: it takes the keys, Esc closes it, toasts wait behind it.
      // `rows` sizes it inline, `columns` docked (the person's own drag wins).
      const opened = await $.ui
        .open({ id: CONFIG_PANE, title: 'Live voice settings', focus: true, closeOnEscape: true, holdToasts: true, rows: 16, columns: 100 })
        .catch(() => undefined)
      const head = opened?.isPlaced === true
        ? 'Live voice settings opened (Esc closes).'
        : 'Could not open the settings dialog here (a wider terminal shows it).'
      return { text: `${head}\n${await summary($)}` }
    }
    case 'config-test':
      return { text: await testVoice($) }
    case 'config-keys':
      return { text: await describeKeys($) }
    case 'config-keys-apply':
      return { text: await setChords($, live.chords) }
    case 'config-chord':
      return { text: await setChords($, { ...live.chords, [command.which]: command.chord }) }
    case 'config-reset':
      await resetSettings($)
      return { text: 'Settings restored to the defaults.' }
    case 'config-animation':
      await setAnimation($, command.animation)
      return { text: `Animation set to ${command.animation}.` }
    case 'config-silence':
      await setSilence($, command.silenceMs)
      return { text: `End-of-speech silence set to ${command.silenceMs} ms.` }
    case 'config-interrupt':
      await setInterrupt($, command.interrupt)
      return { text: `Interrupt set to ${command.interrupt}.` }
    case 'config-set':
      await pickColor($, command.target, command.color)
      return { text: `${command.target} color set to ${command.color}.` }
    case 'config-engine':
      await setEngine($, command.engine)
      return { text: `Engine set to ${command.engine}.` }
    case 'config-codex-voice':
      await setCodexVoice($, command.voice)
      return { text: `Codex voice set to ${command.voice}.` }
    case 'config-codex':
      return { text: await codexAccount($, command.action) }
    case 'error':
      return { text: command.message || USAGE }
  }
}

export const register: Register = (on, options) => {
  // From the built-in defaults, not the module's: a hot reload keeps the module's last picks.
  live.voice = String(options.voice ?? SETTINGS.voice)
  config.language = String(options.language ?? config.language)
  config.whisperUrl = String(options.whisperUrl ?? config.whisperUrl)
  config.kokoroUrl = String(options.kokoroUrl ?? config.kokoroUrl)
  config.echoTailMs = tunable(options.echoTailMs, config.echoTailMs)
  config.vadEndSilenceMs = Math.max(1, Math.round(tunable(options.vadEndSilenceMs, SETTINGS.silenceMs)))
  config.vadStartFrames = Math.max(1, Math.round(tunable(options.vadStartFrames, config.vadStartFrames)))
  config.vadThresholdFactor = tunable(options.vadThresholdFactor, config.vadThresholdFactor)
  defaults.voice = live.voice
  defaults.silenceMs = config.vadEndSilenceMs

  on('session.start', async ($, e, next) => {
    const root = $.plugin.root
    config.scripts = (await $.fs.exists(`${root}/scripts/listen.py`)) ? `${root}/scripts` : `${root}/../scripts`
    const sessionId = await $.session.id()
    config.sessionId = sessionId
    config.tag = sessionTag(sessionId)
    config.dir = `${(await $.env.get('XDG_RUNTIME_DIR')) ?? '/tmp'}/live-voice/${safeSessionId(sessionId)}`
    config.pauseFile = `${config.dir}/paused`
    config.codexDir = `${config.dir}/codex`
    // A hot reload runs this again: the module started over, $.state did not.
    const was = await read($, status)
    forgetChildren()
    const stored = await $.store.get('colors').catch(() => undefined)
    await update($, colors, () => liveColors(stored))
    const kept: Record<string, unknown> = {}
    for (const key of STORED) kept[key] = await $.store.get(key).catch(() => undefined)
    live.chords = liveChords(await $.store.get('chords').catch(() => undefined))
    const loaded = liveSettings(kept, { ...defaults, animation: 'wave', interrupt: SETTINGS.interrupt })
    live.voice = loaded.voice
    live.animation = loaded.animation
    live.interrupt = loaded.interrupt
    config.vadEndSilenceMs = loaded.silenceMs
    const engine = codexSettings(kept, { engine: SETTINGS.engine, codexVoice: SETTINGS.codexVoice })
    live.engine = engine.engine
    live.codexVoice = engine.codexVoice
    await showSettings($)
    const voice = live.engine === 'codex' ? live.codexVoice : live.voice
    await update($, status, () => (was.isOn ? { ...was, queue: 0, voice } : { ...OFF, voice }))
    $.clock.after(0, () => void recover($, was))
    await $.command.register({
      name: 'live',
      description: 'Hands-free voice conversation (local Whisper + Kokoro, or the optional Codex engine); /live config: voice, colors, animation, silence, interrupt, engine',
      argumentHint: '[on|off|mute|status|voice <name>|config [test|voice <name>|animation <wave|bars|off>|silence <ms>|interrupt <off|headphones|speakers>|<target> <theme|name|#hex>|keys [apply]|mute <chord>|stop <chord>|engine <local|codex>|codex <login|logout|status|voice <name>>|reset]]',
      immediate: true,
    })
    await $.command.register({
      name: 'live-config',
      description: 'Live voice settings: voice, colors, animation, end-of-speech silence, interrupt by voice, mute/stop shortcuts, engine, Codex sign-in',
      argumentHint: '[test|voice <name>|animation <wave|bars|off>|silence <ms>|interrupt <off|headphones|speakers>|<target> <theme|name|#hex>|keys [apply]|mute <chord>|stop <chord>|engine <local|codex>|codex <login|logout|status|voice <name>>|reset]',
      immediate: true,
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stop($)

    return next(e)
  })

  on('command.run', { command: 'live-config' }, ($, e) => answerLive($, `config ${e.args}`.trim()))

  on('command.run', { command: 'live' }, ($, e) => answerLive($, e.args))

  // A system message (a task's notification, another session's message, a
  // schedule, a channel) while live voice is on: kept like a transcript, so
  // the turn it starts is spoken, after the notice cue. One delivered into a
  // running turn (`turnId` set) starts none, so nothing is kept. The prompt
  // passes on untouched.
  on('prompt.submit', async ($, e, next) => {
    if (!live.isOn || e.turnId !== undefined || !SPOKEN_ORIGINS.has(e.origin.kind)) return next(e)
    const prompt: SubmittedPrompt = { sent: e.text.trim(), entered: undefined, isEntering: true, isNotice: true }
    live.prompts.push(prompt)
    try {
      const entered = await next(e)
      if (entered.drop !== undefined) forget(prompt)
      else prompt.entered = entered.text.trim()

      return entered
    } catch (error) {
      forget(prompt)
      throw error
    } finally {
      prompt.isEntering = false
    }
  })

  on('turn.start', ($, e, next) => {
    const prompt = live.isOn ? claim(live.prompts, e.text) : undefined
    if (prompt !== undefined && live.engine === 'codex') {
      forget(prompt)
      // Voice requests queued while Claude was busy can enter as one turn: it answers them all.
      const merged = live.prompts.filter(other => other.delegation !== undefined && other.sent !== '' && e.text.includes(other.sent))
      for (const other of merged) forget(other)
      const delegations = [prompt, ...merged].flatMap(one => (one.delegation === undefined ? [] : [one.delegation]))
      live.codexTurns.set(e.turnId, { delegations, pending: '', isNotice: prompt.isNotice === true })
    } else if (prompt !== undefined) {
      forget(prompt)
      live.turns.set(e.turnId, new SentenceChunker())
      if (prompt.isNotice === true) live.cues.add(e.turnId)
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // A Codex live turn: a step that calls tools sends its text as silent
    // progress; the text of the last one is the answer, sent on turn.complete.
    const codexTurn = e.agentId === undefined ? live.codexTurns.get(e.turnId) : undefined
    if (codexTurn !== undefined) {
      const stream = next(e)
      for await (const chunk of stream) yield chunk
      const result = await stream.result
      const text = result.answer.trim()
      if (text !== '' && live.codexTurns.get(e.turnId) === codexTurn) {
        if (result.toolUses.length === 0) codexTurn.pending = text
        else if (!codexTurn.isNotice) for (const id of codexTurn.delegations) await sendCodex($, { type: 'commentary', id, text })
      }

      return result
    }
    const chunker = e.agentId === undefined ? live.turns.get(e.turnId) : undefined
    if (chunker === undefined) {
      return yield* next(e)
    }
    const stream = next(e)
    let block = -1
    // A barge-in forgets the turn: the rest of its reply is not spoken.
    const isLive = () => live.turns.get(e.turnId) === chunker
    for await (const chunk of stream) {
      if (chunk.kind === 'text' && isLive()) {
        const pieces = block >= 0 && chunk.index !== block ? chunker.push('\n') : []
        block = chunk.index
        enqueueTurn($, e.turnId, [...pieces, ...chunker.push(chunk.text)])
      }
      yield chunk
    }
    if (isLive()) enqueueTurn($, e.turnId, chunker.push('\n'))

    return stream.result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const codexTurn = live.codexTurns.get(e.turnId)
    if (codexTurn !== undefined) {
      live.codexTurns.delete(e.turnId)
      const text = e.answer.trim() || codexTurn.pending
      if (e.reason === 'aborted') {
        for (const id of codexTurn.delegations) await sendCodex($, { type: 'cancel', id })
      } else if (codexTurn.isNotice) {
        if (text !== '') await sendCodex($, { type: 'notice', text })
      } else {
        for (const id of codexTurn.delegations) await sendCodex($, { type: 'final', id, text })
      }
      if (live.isOn) await publish($)

      return next(e)
    }
    const chunker = live.turns.get(e.turnId)
    live.turns.delete(e.turnId)
    if (e.reason === 'aborted') {
      await silence($)
    } else if (chunker !== undefined) {
      enqueueTurn($, e.turnId, chunker.flush())
    }
    live.cues.delete(e.turnId)
    if (live.isOn) await publish($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, status)
    if (!now.isOn || !live.isOn || e.props.hasSurvey) {
      return next(e)
    }
    const palette = liveColors(await read($, colors))
    const { animation } = await read($, settings)
    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    // A state from before a reload may lack the level; the next publish fills it.
    const level = typeof now.level === 'number' ? now.level : 0
    // The live dot (blank while dark, so nothing shifts) then the mic; muted,
    // a steady muted mic. Both in the dot color: a glyph, as an emoji keeps its own.
    const mic = live.isMuted ? '🔇' : `${now.dot === true ? '●' : ' '}🎙`
    const muteLabel = live.isMuted ? '🎙 Unmute' : '🔇 Mute'
    const stopLabel = '⏹ Stop'
    const width = audioBarWaveWidth(columns, [mic, `m: ${muteLabel}`, `s: ${stopLabel}`, BAR])
    // Who is talking: the person, Claude, or nobody (dim); with no animation, a still dim line.
    // The person's voice draws the same wave as Claude's; listening in silence, a still flat line.
    const isIdle = animation === 'off' || (now.state !== 'listening' && now.state !== 'speaking')
    const frame = now.wave ?? 0
    const wave = isIdle
      ? flatRow(width)
      : animation === 'bars'
        ? barsRow(frame, now.state === 'listening' ? level : 0.8, width)
        : now.state === 'listening' && !isVoiced(level)
          ? flatRow(width)
          : waveRow(frame, width)
    const waveColor = isIdle ? palette.idle : now.state === 'listening' ? palette.user : palette.agent
    const queued = now.queue > 0 ? ` · ${now.queue} queued` : ''
    const about = `${now.state} · ${now.voice}${queued}`
    // The hint goes first when the text bar is narrow.
    const hint = chordsHint(live.chords)
    const hasHint = cellWidth(about) + 2 + cellWidth(hint) <= columns

    // The audio bar (dot and mic, the controls, the wave across the rest),
    // then the text bar; with room for one row only, the audio bar, which
    // holds the controls. The controls are never cut: the wave gives way.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={palette.dot}>{mic}</Text>
          <Button
            key="mute"
            plain
            hotkey="m"
            action={MUTE_ACTION}
            label={muteLabel}
            onPress={() => toggleMute($)}
          />
          <Button key="stop" plain hotkey="s" action={STOP_ACTION} label={stopLabel} onPress={() => void stopVoice($)} />
          <Text dimColor>{BAR}</Text>
          {width >= MIN_WAVE ? (
            <Text color={waveColor} dimColor={isIdle} wrap="truncate-end">
              {wave}
            </Text>
          ) : null}
        </Box>
        {e.props.maxRows >= 2 ? (
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor wrap="truncate-end">
              {about}
            </Text>
            {hasHint ? <Text dimColor>{hint}</Text> : null}
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CONFIG_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const now = liveColors(await read($, colors))
    const current = await read($, settings)
    // A surface with no Select (mobile) gets the settings and the commands instead.
    if (!('Select' in elements)) {
      return (
        <Box flexDirection="column">
          <Text>Voice           {voiceLabel(current.voice)}</Text>
          <Text>Animation       {current.animation}</Text>
          <Text>End silence     {current.silenceMs} ms</Text>
          <Text>Interrupt       {current.interrupt}</Text>
          <Text>Engine          {current.engine ?? SETTINGS.engine}</Text>
          <Text>Codex voice     {current.codexVoice ?? SETTINGS.codexVoice}</Text>
          {COLOR_TARGETS.map(target => (
            <Text>
              {COLOR_LABELS[target]} <Text color={now[target]}>●</Text> {now[target]}
            </Text>
          ))}
          <Text dimColor>{CONFIG_USAGE}</Text>
        </Box>
      )
    }
    const { Select } = elements
    const editing = await read($, editor)
    const edited = now[editing.target]
    const rgb = hexToRgb(customBase(edited)) ?? [128, 128, 128]
    // Theme keys, then names; a target's custom hex is offered as itself.
    const colorOptions = (target: keyof LiveVoiceColors) =>
      selectOptions([
        ...[...THEME_COLORS, ...COLORS].map(color => ({ value: color })),
        ...(now[target].startsWith('#') ? [{ value: now[target] }] : []),
      ])
    // Two steps, as a Select takes at most 64 options and Kokoro lists more:
    // a native language (the session's first), then that language's voices.
    const picker = voicePicker(live.voices, current.voice, config.language, editing.voiceLanguage)
    const voices = picker.voices.map(voice => voice.id)
    const silences = SILENCES.includes(current.silenceMs) ? SILENCES : [...SILENCES, current.silenceMs].sort((a, b) => a - b)

    // The room the dock (or the inline block) gives, less a margin for a
    // painter that draws a mark wider than counted: every row fits on one line.
    const room = Math.max(1, e.props.bodyColumns - 2)
    const barCells = channelBarWidth(room)
    const languageOptions = picker.languages.map(language => ({ value: language }))
    const voiceOptions = voices.map(voice => ({ value: voice, label: voiceChoice(voice) }))
    const targetOptions = COLOR_TARGETS.map(target => ({ value: target, label: COLOR_LABELS[target].trim() }))
    const animationOptions = ANIMATIONS.map(animation => ({ value: animation }))
    const silenceOptions = silences.map(ms => ({ value: String(ms) }))
    const interruptOptions = INTERRUPTS.map(interrupt => ({ value: interrupt }))
    const engineOptions = ENGINES.map(engine => ({ value: engine }))
    const codexVoiceOptions = CODEX_VOICES.map(voice => ({ value: voice }))
    const preview = waveFrame(0)
    const stepFine = 'fine'
    const stepCoarse = `coarse (${COARSE})`
    const closeLabel = 'Close (Esc)'
    // Fields packed into as many rows as the room needs, two cells apart.
    type Field = { width: number; node: JSX.Element }
    const GAP = 2
    const pack = (key: string, fields: Field[]) =>
      packRows(fields.map(field => field.width), room, GAP).map((row, index) => (
        <Box key={`${key}-${index}`} flexDirection="row" gap={GAP}>
          {row.map(at => fields[at]?.node)}
        </Box>
      ))

    const voiceFields: Field[] = [
      {
        width: selectWidth('Language', languageOptions),
        node: (
          <Select
            key="voice-language"
            label="Language"
            options={languageOptions}
            value={picker.language}
            autoFocus
            onSelect={(value: string) => {
              if (picker.languages.includes(value)) void setEditor($, { voiceLanguage: value })
            }}
          />
        ),
      },
      {
        width: selectWidth('Voice', voiceOptions),
        node: (
          <Select
            key="voice"
            label="Voice"
            options={voiceOptions}
            {...(voices.includes(current.voice) ? { value: current.voice } : {})}
            onSelect={(value: string) => {
              if (voices.includes(value)) void setVoice($, value)
            }}
          />
        ),
      },
      {
        width: cellWidth('t: Test voice'),
        node: (
          <Button
            key="test-voice"
            plain
            hotkey="t"
            label="Test voice"
            onPress={async () => {
              const answer = await testVoice($)
              if (answer.startsWith('Live voice is busy')) $.ui.toast(`live-voice: ${answer}`)
            }}
          />
        ),
      },
    ]
    const colorFields: Field[] = COLOR_TARGETS.map(target => ({
      width: cellWidth(SHORT_COLOR_LABELS[target]) + 1 + 1 + 1 + selectWidth('', colorOptions(target)),
      node: (
        <Box key={`color-row-${target}`} flexDirection="row" gap={1}>
          <Text>{SHORT_COLOR_LABELS[target]}</Text>
          <Text color={now[target]}>●</Text>
          <Select
            key={`color-${target}`}
            options={colorOptions(target)}
            value={now[target]}
            onSelect={(value: string) => {
              const color = parseColor(value)
              if (color !== undefined) void pickColor($, target, color)
            }}
          />
        </Box>
      ),
    }))
    const editFields: Field[] = [
      {
        width: selectWidth('Edit', targetOptions),
        node: (
          <Select
            key="edit-target"
            label="Edit"
            options={targetOptions}
            value={editing.target}
            onSelect={(value: string) => {
              const target = COLOR_TARGETS.find(one => one === value)
              if (target !== undefined) void setEditor($, { target })
            }}
          />
        ),
      },
      {
        width: cellWidth('Theme') + 2 * THEME_COLORS.length,
        node: (
          <Box key="theme-row" flexDirection="row" gap={1}>
            <Text>Theme</Text>
            {THEME_COLORS.map(key => (
              <Button key={`theme-${key}`} plain onPress={() => void pickColor($, editing.target, key)}>
                <Text color={key}>●</Text>
              </Button>
            ))}
          </Box>
        ),
      },
    ]
    const stepFields: Field[] = [
      {
        width: cellWidth('Step') + 1 + cellWidth(`1: ${stepFine}`) + 1 + cellWidth(`2: ${stepCoarse}`),
        node: (
          <Box key="step-row" flexDirection="row" gap={1}>
            <Text>Step</Text>
            <Button key="step-fine" plain hotkey="1" label={stepFine} dimColor={editing.step !== FINE} onPress={() => void setEditor($, { step: FINE })} />
            <Button key="step-coarse" plain hotkey="2" label={stepCoarse} dimColor={editing.step !== COARSE} onPress={() => void setEditor($, { step: COARSE })} />
          </Box>
        ),
      },
      {
        width: cellWidth('Preview') + 1 + cellWidth(preview) + 1 + cellWidth(edited),
        node: (
          <Box key="preview-row" flexDirection="row" gap={1}>
            <Text>Preview</Text>
            <Text color={edited}>{preview}</Text>
            <Text dimColor>{edited}</Text>
          </Box>
        ),
      },
    ]
    const timingFields: Field[] = [
      {
        width: selectWidth('Animation', animationOptions),
        node: (
          <Select
            key="animation"
            label="Animation"
            options={animationOptions}
            value={current.animation}
            onSelect={(value: string) => {
              const animation = ANIMATIONS.find(one => one === value)
              if (animation !== undefined) void setAnimation($, animation)
            }}
          />
        ),
      },
      {
        width: selectWidth('Silence ms', silenceOptions),
        node: (
          <Select
            key="silence"
            label="Silence ms"
            options={silenceOptions}
            value={String(current.silenceMs)}
            onSelect={(value: string) => {
              const ms = Number(value)
              if (silences.includes(ms)) void setSilence($, ms)
            }}
          />
        ),
      },
      {
        width: selectWidth('Interrupt', interruptOptions),
        node: (
          <Select
            key="interrupt"
            label="Interrupt"
            options={interruptOptions}
            value={current.interrupt}
            onSelect={(value: string) => {
              const interrupt = INTERRUPTS.find(one => one === value)
              if (interrupt !== undefined) void setInterrupt($, interrupt)
            }}
          />
        ),
      },
    ]
    const engineFields: Field[] = [
      {
        width: selectWidth('Engine', engineOptions),
        node: (
          <Select
            key="engine"
            label="Engine"
            options={engineOptions}
            value={current.engine ?? SETTINGS.engine}
            onSelect={(value: string) => {
              const engine = ENGINES.find(one => one === value)
              if (engine !== undefined) void setEngine($, engine)
            }}
          />
        ),
      },
      {
        width: selectWidth('Codex voice', codexVoiceOptions),
        node: (
          <Select
            key="codex-voice"
            label="Codex voice"
            options={codexVoiceOptions}
            value={current.codexVoice ?? SETTINGS.codexVoice}
            onSelect={(value: string) => {
              if (CODEX_VOICES.includes(value)) void setCodexVoice($, value)
            }}
          />
        ),
      },
    ]
    // The band's chords: the suggestions, and a chord set by hand offered as itself.
    const chordOptions = (which: keyof Chords) =>
      selectOptions(
        [...SUGGESTED_CHORDS, ...(SUGGESTED_CHORDS.includes(live.chords[which]) ? [] : [live.chords[which]])].map(chord => ({
          value: chord,
          label: chordLabel(chord),
        })),
      )
    const chordFields: Field[] = (['mute', 'stop'] as const).map(which => {
      const label = which === 'mute' ? 'Mute' : 'Stop'

      return {
        width: selectWidth(label, chordOptions(which)),
        node: (
          <Select
            key={`chord-${which}`}
            label={label}
            options={chordOptions(which)}
            value={live.chords[which]}
            onSelect={async (value: string) => {
              if (!chordOptions(which).some(option => option.value === value)) return
              const answer = await setChords($, { ...live.chords, [which]: value })
              if (!answer.startsWith('Shortcuts set')) $.ui.toast(`live-voice: ${answer}`)
            }}
          />
        ),
      }
    })
    const actionFields: Field[] = [
      { width: cellWidth('Restore'), node: <Button key="restore" plain label="Restore" onPress={() => void resetSettings($)} /> },
      { width: cellWidth(closeLabel), node: <Button key="close" plain label={closeLabel} onPress={() => void $.ui.close({ id: CONFIG_PANE })} /> },
    ]

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">Live voice, kept for later sessions. Esc closes.</Text>
        {pack('voice', voiceFields)}
        <Text dimColor wrap="truncate-end">{`Now  ${voiceLabel(current.voice)}`}</Text>
        {pack('colors', colorFields)}
        {pack('edit', editFields)}
        {CHANNELS.map((one, index) => (
          <Box key={`${one.key}-row`} flexDirection="row" gap={1}>
            <Text>{one.label}</Text>
            <Text color={one.color}>{channelBar(rgb[index] ?? 0, barCells)}</Text>
            <Text>{String(rgb[index] ?? 0).padStart(3)}</Text>
            <Button key={`${one.key}-down`} plain hotkey={one.down} label="−" onPress={() => void nudgeChannel($, index as 0 | 1 | 2, -1)} />
            <Button key={`${one.key}-up`} plain hotkey={one.up} label="+" onPress={() => void nudgeChannel($, index as 0 | 1 | 2, 1)} />
          </Box>
        ))}
        {pack('step', stepFields)}
        {pack('timing', timingFields)}
        {pack('engine', engineFields)}
        {pack('chords', [{ width: cellWidth('Shortcuts'), node: <Text key="chords-label">Shortcuts</Text> }, ...chordFields])}
        {pack('actions', actionFields)}
      </Box>
    )
  })
}
