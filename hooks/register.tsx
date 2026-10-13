import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { LiveVoiceAnimation, LiveVoiceColors, LiveVoiceSettings, LiveVoiceState, LiveVoiceStatus } from '../types'
import {
  ANIMATIONS,
  COLORS,
  CONFIG_USAGE,
  COLOR_TARGETS,
  DEFAULT_COLORS,
  FALLBACK_VOICES,
  SILENCES,
  SentenceChunker,
  USAGE,
  claim,
  audioBarWaveWidth,
  barsRow,
  bounceRow,
  cellWidth,
  cleanTranscript,
  flatRow,
  killPattern,
  liveColors,
  liveSettings,
  parseListenerLine,
  parseLiveCommand,
  safeSessionId,
  sessionTag,
  smoothLevel,
  sortVoices,
  tunable,
  waveRow,
} from './text.ts'
import type { SubmittedPrompt } from './text.ts'

type $ = EngineInterface
type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

const OFF: LiveVoiceStatus = { isOn: false, state: 'off', queue: 0, voice: '', level: 0, wave: 0, dot: false }
const status = atom({ plugin: 'live-voice', key: 'status' } as const, OFF)
const colors = atom({ plugin: 'live-voice', key: 'colors' } as const, DEFAULT_COLORS)
const SETTINGS: LiveVoiceSettings = { voice: 'ef_dora', animation: 'wave', silenceMs: 2000 }
const settings = atom({ plugin: 'live-voice', key: 'settings' } as const, SETTINGS)

// The settings dialog's pane, and what each of its Selects is labelled.
const CONFIG_PANE = 'live-voice-config'
const COLOR_LABELS: Record<keyof LiveVoiceColors, string> = {
  user: 'You speaking   ',
  agent: 'Claude speaking',
  dot: 'Live dot       ',
  idle: 'Idle line      ',
}
// The `$.store` keys of the settings kept beside `colors`.
const STORED = ['voice', 'animation', 'silenceMs'] as const

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
  queue: [] as string[],
  isSpeaking: false,
  // Transcripts this plugin submitted, not yet claimed by a turn.start.
  prompts: [] as SubmittedPrompt[],
  // Live turns by id, each with the chunker of its spoken reply.
  turns: new Map<string, SentenceChunker>(),
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
  ticker: undefined as Timer | undefined,
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
}

// What `/live config reset` restores: the plugin's settings (`/config`), or
// the built-in defaults.
const defaults = { voice: 'ef_dora', silenceMs: 2000 }

const stateNow = (): LiveVoiceState => {
  if (!live.isOn) return 'off'
  if (live.isSpeaking || live.queue.length > 0) return 'speaking'
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
    voice: live.voice,
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

// Moves the wave while listening or speaking and blinks the dot while not
// muted; redraws only when one of them changed. One timer, started with live
// voice and stopped with it.
const startTicker = ($: $) => {
  stopTicker()
  live.ticks = 0
  live.dot = true
  live.ticker = $.clock.every(TICK_MS, () => {
    live.ticks += 1
    const dot = Math.floor(live.ticks / BLINK_TICKS) % 2 === 0
    const hasBlinked = dot !== live.dot
    live.dot = dot
    const state = stateNow()
    const isMoving = live.animation !== 'off' && (state === 'listening' || state === 'speaking')
    if (isMoving) live.waveTick += 1
    if (isMoving || (hasBlinked && !live.isMuted)) void publish($).catch(() => undefined)
  })
}

const stopTicker = () => {
  live.ticker?.cancel()
  live.ticker = undefined
}

// The listener discards audio while the flag file holds "1".
const writePause = ($: $) =>
  $.fs.write(config.pauseFile, live.isMuted || live.isSpeaking || live.queue.length > 0 ? '1' : '0')

// Stops this session's children of one script (listen.py or speak.sh): the
// pattern needs the script name and this session's tag, so other sessions'
// children never match. The fallback for a child its stream did not stop.
const kill = ($: $, script: 'listen.py' | 'speak.sh') =>
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
const submit = ($: $, text: string) => {
  const prompt: SubmittedPrompt = { sent: text, entered: undefined, isEntering: true }
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
  await $.clock.sleep(config.echoTailMs).catch(() => undefined)
  live.isSpeaking = false
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

const silence = async ($: $) => {
  live.queue = []
  const player = live.player
  live.player = undefined
  if (player !== undefined) {
    void player.return(undefined as never).catch(() => undefined)
    await kill($, 'speak.sh')
  }
  await publish($)
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
    ],
  })
  live.listener = child
  $.clock.after(0, () => void listen($, child))
}

const start = async ($: $) => {
  if (live.isOn) return
  live.isOn = true
  live.isMuted = false
  await $.process.run(['mkdir', '-p', config.dir])
  await writePause($)
  startTicker($)
  spawnListener($)
  await publish($)
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
  for (const child of [live.listener, live.player]) {
    void child?.return(undefined as never).catch(() => undefined)
  }
  live.isOn = false
  live.isMuted = false
  live.isTranscribing = false
  live.listener = undefined
  live.player = undefined
  live.queue = []
  live.isSpeaking = false
  live.prompts = []
  live.turns.clear()
  live.level = 0
  stopTicker()
}

// After session.start: kills this session's orphaned children, then, when
// live voice was on before a reload, listens again (muted if it was).
const recover = async ($: $, was: LiveVoiceStatus) => {
  await kill($, 'listen.py')
  await kill($, 'speak.sh')
  if (!was.isOn) return
  await start($)
  if (was.state === 'muted') {
    live.isMuted = true
    await writePause($)
    await publish($)
  }
}

const stop = async ($: $) => {
  live.isOn = false
  stopTicker()
  live.prompts = []
  live.turns.clear()
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
const pickColor = async ($: $, target: keyof LiveVoiceColors, color: LiveVoiceColors[keyof LiveVoiceColors]) =>
  setColors($, { ...liveColors(await read($, colors)), [target]: color })

// Keeps one setting for later sessions; a failed write says so.
const keep = async ($: $, key: (typeof STORED)[number], value: unknown) =>
  $.store.set(key, value).catch(() => $.ui.toast(`live-voice: could not save the ${key}`))

// Shows the settings as they are now, to the band and the dialog.
const showSettings = ($: $) =>
  update($, settings, () => ({ voice: live.voice, animation: live.animation, silenceMs: config.vadEndSilenceMs }))

const setVoice = async ($: $, voice: string) => {
  live.voice = voice
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

// Back to the plugin's settings and the default colors; nothing kept.
const resetSettings = async ($: $) => {
  await setColors($, DEFAULT_COLORS)
  live.voice = defaults.voice
  live.animation = 'wave'
  const isNew = config.vadEndSilenceMs !== defaults.silenceMs
  config.vadEndSilenceMs = defaults.silenceMs
  await showSettings($)
  await Promise.all(STORED.map(key => $.store.delete(key).catch(() => undefined)))
  await publish($)
  if (isNew) await restartListener($)
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
    `  voice      ${live.voice}`,
    `  animation  ${live.animation}`,
    `  silence    ${config.vadEndSilenceMs} ms`,
    `  colors     ${COLOR_TARGETS.map(target => `${target} ${now[target]}`).join(' · ')}`,
    'Change one with /live config voice <name>, or:',
    CONFIG_USAGE,
  ].join('\n')
}

const describe = () =>
  live.isOn
    ? `Live voice is on: ${stateNow()}, voice ${live.voice}, ${live.queue.length} sentence(s) queued.`
    : `Live voice is off. Voice ${live.voice}.`


// A mod cannot name keybinding actions of its own, so the band borrows two the
// engine does not act on: a chord the person binds to one in
// ~/.claude/keybindings.json presses the button from the prompt.
const MUTE_ACTION = 'permission:toggleDebug'
const STOP_ACTION = 'footer:dismiss'

// The audio bar's separator before the wave, the narrowest wave worth
// drawing, and the text bar's hint of the chords suggested in the README.
const BAR = '│'
const MIN_WAVE = 4
const HINT = 'alt+space mute · alt+s stop'

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
    config.tag = sessionTag(sessionId)
    config.dir = `${(await $.env.get('XDG_RUNTIME_DIR')) ?? '/tmp'}/live-voice/${safeSessionId(sessionId)}`
    config.pauseFile = `${config.dir}/paused`
    // A hot reload runs this again: the module started over, $.state did not.
    const was = await read($, status)
    forgetChildren()
    const stored = await $.store.get('colors').catch(() => undefined)
    await update($, colors, () => liveColors(stored))
    const kept: Record<string, unknown> = {}
    for (const key of STORED) kept[key] = await $.store.get(key).catch(() => undefined)
    const loaded = liveSettings(kept, { ...defaults, animation: 'wave' })
    live.voice = loaded.voice
    live.animation = loaded.animation
    config.vadEndSilenceMs = loaded.silenceMs
    await showSettings($)
    await update($, status, () => (was.isOn ? { ...was, queue: 0, voice: live.voice } : { ...OFF, voice: live.voice }))
    $.clock.after(0, () => void recover($, was))
    await $.command.register({
      name: 'live',
      description: 'Hands-free voice conversation (local Whisper + Kokoro); /live config: voice, colors, animation, silence',
      argumentHint: '[on|off|mute|status|voice <name>|config [voice <name>|animation <wave|bars|off>|silence <ms>|<target> <color>|reset]]',
      immediate: true,
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stop($)

    return next(e)
  })

  on('command.run', { command: 'live' }, async ($, e) => {
    const command = parseLiveCommand(e.args)
    switch (command.kind) {
      case 'toggle':
        if (live.isOn) {
          await stop($)
          return { text: 'Live voice off.' }
        }
        await start($)
        return { text: `Live voice on. Speak; voice ${live.voice}.` }
      case 'on':
        await start($)
        return { text: `Live voice on. Speak; voice ${live.voice}.` }
      case 'off':
        await stop($)
        return { text: 'Live voice off.' }
      case 'mute':
        if (!live.isOn) return { text: 'Live voice is off.' }
        live.isMuted = !live.isMuted
        await writePause($)
        await publish($)
        return { text: live.isMuted ? 'Microphone muted.' : 'Microphone unmuted.' }
      case 'status':
        return { text: describe() }
      case 'voice':
      case 'config-voice':
        await setVoice($, command.voice)
        return { text: `Voice set to ${command.voice}.` }
      case 'config': {
        await loadVoices($)
        // A dialog: it takes the keys, Esc closes it, toasts wait behind it.
        const opened = await $.ui
          .open({ id: CONFIG_PANE, title: 'Live voice settings', focus: true, closeOnEscape: true, holdToasts: true, rows: 12 })
          .catch(() => undefined)
        const head = opened?.isPlaced === true
          ? 'Live voice settings opened (Esc closes).'
          : 'Could not open the settings dialog here (a wider terminal shows it).'
        return { text: `${head}\n${await summary($)}` }
      }
      case 'config-reset':
        await resetSettings($)
        return { text: 'Settings restored to the defaults.' }
      case 'config-animation':
        await setAnimation($, command.animation)
        return { text: `Animation set to ${command.animation}.` }
      case 'config-silence':
        await setSilence($, command.silenceMs)
        return { text: `End-of-speech silence set to ${command.silenceMs} ms.` }
      case 'config-set':
        await pickColor($, command.target, command.color)
        return { text: `${command.target} color set to ${command.color}.` }
      case 'error':
        return { text: command.message || USAGE }
    }
  })

  on('turn.start', ($, e, next) => {
    const prompt = live.isOn ? claim(live.prompts, e.text) : undefined
    if (prompt !== undefined) {
      forget(prompt)
      live.turns.set(e.turnId, new SentenceChunker())
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const chunker = e.agentId === undefined ? live.turns.get(e.turnId) : undefined
    if (chunker === undefined) {
      return yield* next(e)
    }
    const stream = next(e)
    let block = -1
    for await (const chunk of stream) {
      if (chunk.kind === 'text') {
        const pieces = block >= 0 && chunk.index !== block ? chunker.push('\n') : []
        block = chunk.index
        enqueue($, [...pieces, ...chunker.push(chunk.text)])
      }
      yield chunk
    }
    enqueue($, chunker.push('\n'))

    return stream.result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const chunker = live.turns.get(e.turnId)
    live.turns.delete(e.turnId)
    if (e.reason === 'aborted') {
      await silence($)
    } else if (chunker !== undefined) {
      enqueue($, chunker.flush())
    }
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
    const isIdle = animation === 'off' || (now.state !== 'listening' && now.state !== 'speaking')
    const frame = now.wave ?? 0
    const wave = isIdle
      ? flatRow(width)
      : animation === 'bars'
        ? barsRow(frame, now.state === 'listening' ? level : 0.8, width)
        : now.state === 'listening'
          ? bounceRow(frame, level, width)
          : waveRow(frame, width)
    const waveColor = isIdle ? palette.idle : now.state === 'listening' ? palette.user : palette.agent
    const queued = now.queue > 0 ? ` · ${now.queue} queued` : ''
    const about = `${now.state} · ${now.voice}${queued}`
    // The hint goes first when the text bar is narrow.
    const hasHint = cellWidth(about) + 2 + cellWidth(HINT) <= columns

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
            onPress={async () => {
              live.isMuted = !live.isMuted
              await writePause($)
              await publish($)
            }}
          />
          <Button key="stop" plain hotkey="s" action={STOP_ACTION} label={stopLabel} onPress={() => void silence($)} />
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
            {hasHint ? <Text dimColor>{HINT}</Text> : null}
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
          <Text>Voice           {current.voice}</Text>
          <Text>Animation       {current.animation}</Text>
          <Text>End silence     {current.silenceMs} ms</Text>
          {COLOR_TARGETS.map(target => (
            <Text>
              {COLOR_LABELS[target]} {now[target]}
            </Text>
          ))}
          <Text dimColor>{CONFIG_USAGE}</Text>
        </Box>
      )
    }
    const { Select } = elements
    const colorOptions = COLORS.map(color => ({ value: color }))
    const voices = live.voices.includes(current.voice) ? live.voices : [current.voice, ...live.voices]
    const silences = SILENCES.includes(current.silenceMs) ? SILENCES : [...SILENCES, current.silenceMs].sort((a, b) => a - b)

    return (
      <Box flexDirection="column">
        <Text dimColor>Live voice, kept for later sessions. Esc closes.</Text>
        <Select
          key="voice"
          label="Voice           "
          options={voices.map(voice => ({ value: voice }))}
          value={current.voice}
          autoFocus
          onSelect={(value: string) => {
            if (voices.includes(value)) void setVoice($, value)
          }}
        />
        {COLOR_TARGETS.map(target => (
          <Select
            key={`color-${target}`}
            label={`${COLOR_LABELS[target]} `}
            options={colorOptions}
            value={now[target]}
            onSelect={(value: string) => {
              const color = COLORS.find(one => one === value)
              if (color !== undefined) void pickColor($, target, color)
            }}
          />
        ))}
        <Select
          key="animation"
          label="Animation       "
          options={ANIMATIONS.map(animation => ({ value: animation }))}
          value={current.animation}
          onSelect={(value: string) => {
            const animation = ANIMATIONS.find(one => one === value)
            if (animation !== undefined) void setAnimation($, animation)
          }}
        />
        <Select
          key="silence"
          label="End silence (ms)"
          options={silences.map(ms => ({ value: String(ms) }))}
          value={String(current.silenceMs)}
          onSelect={(value: string) => {
            const ms = Number(value)
            if (silences.includes(ms)) void setSilence($, ms)
          }}
        />
        <Box flexDirection="row" gap={2}>
          <Button key="restore" plain label="Restore" onPress={() => void resetSettings($)} />
          <Button key="close" plain label="Close" onPress={() => void $.ui.close({ id: CONFIG_PANE })} />
        </Box>
      </Box>
    )
  })
}
