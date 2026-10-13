import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { LiveVoiceState, LiveVoiceStatus } from '../types'
import {
  SentenceChunker,
  USAGE,
  claim,
  cleanTranscript,
  METER_WIDTH,
  killPattern,
  parseListenerLine,
  parseLiveCommand,
  safeSessionId,
  sessionTag,
  sparkline,
  tunable,
  wave,
} from './text.ts'
import type { SubmittedPrompt } from './text.ts'

type $ = EngineInterface
type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

const OFF: LiveVoiceStatus = { isOn: false, state: 'off', queue: 0, voice: '', meter: '' }
const status = atom({ plugin: 'live-voice', key: 'status' } as const, OFF)

const STT_TIMEOUT_MS = 60_000
// One frame of the speaking wave per period: about 7 redraws a second.
const WAVE_MS = 150

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
  // The newest mic levels (0..1) from listen.py, for the meter.
  levels: [] as number[],
  // The speaking wave's frame and the timer that moves it.
  waveTick: 0,
  waveTimer: undefined as Timer | undefined,
  // The meter as last published, so an unchanged one is not redrawn.
  meter: '',
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
  vadEndSilenceMs: 800,
  vadStartFrames: 3,
  vadThresholdFactor: 3,
  scripts: '',
  // This session's tag, in every child's argv so a kill can find only them.
  tag: '',
  dir: '',
  pauseFile: '',
}

const stateNow = (): LiveVoiceState => {
  if (!live.isOn) return 'off'
  if (live.isSpeaking || live.queue.length > 0) return 'speaking'
  if (live.isMuted) return 'muted'
  if (live.isTranscribing) return 'transcribing'
  if (live.prompts.length > 0 || live.turns.size > 0) return 'thinking'
  return 'listening'
}

const meterNow = (state: LiveVoiceState) =>
  state === 'listening' ? sparkline(live.levels) : state === 'speaking' ? wave(live.waveTick) : ''

const publish = ($: $) => {
  const state = stateNow()
  // Levels heard before a pause (speech, mute, an utterance) are stale after it.
  if (state !== 'listening') live.levels = []
  live.meter = meterNow(state)

  return update($, status, () => ({
    isOn: live.isOn,
    state,
    queue: live.queue.length,
    voice: live.voice,
    meter: live.meter,
  }))
}

// Keeps the newest levels; redraws only when the meter, as drawn, changed.
const hearLevels = async ($: $, levels: number[]) => {
  live.levels = [...live.levels, ...levels].slice(-METER_WIDTH)
  const state = stateNow()
  if (state === 'listening' && meterNow(state) !== live.meter) await publish($)
}

const startWave = ($: $) => {
  live.waveTimer?.cancel()
  live.waveTick = 0
  live.waveTimer = $.clock.every(WAVE_MS, () => {
    live.waveTick += 1
    if (stateNow() === 'speaking') void publish($)
  })
}

const stopWave = () => {
  live.waveTimer?.cancel()
  live.waveTimer = undefined
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
// utterance, and meter levels (about 8 a second). The levels of one chunk
// make at most one redraw, so the meter redraws no faster than they come.
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
      if (levels.length > 0) await hearLevels($, levels)
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
  startWave($)
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
      for await (const _ of player) {
        // speak.sh prints only errors; drain them.
      }
      const ended = await player.result
      if (ended.code !== 0 && ended.signal === null && live.isOn) {
        $.ui.toast(`live-voice: speech failed (is Kokoro running at ${config.kokoroUrl}?)`)
      }
    } catch {
      // Stopped mid-sentence.
    }
    live.player = undefined
  }
  stopWave()
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
  stopWave()
  const player = live.player
  live.player = undefined
  if (player !== undefined) {
    void player.return(undefined as never).catch(() => undefined)
    await kill($, 'speak.sh')
  }
  await publish($)
}

const start = async ($: $) => {
  if (live.isOn) return
  live.isOn = true
  live.isMuted = false
  await $.process.run(['mkdir', '-p', config.dir])
  await writePause($)
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
  await publish($)
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
  live.levels = []
  stopWave()
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

const describe = () =>
  live.isOn
    ? `Live voice is on: ${stateNow()}, voice ${live.voice}, ${live.queue.length} sentence(s) queued.`
    : `Live voice is off. Voice ${live.voice}.`


// A mod cannot name keybinding actions of its own, so the band borrows two the
// engine does not act on: a chord the person binds to one in
// ~/.claude/keybindings.json presses the button from the prompt.
const MUTE_ACTION = 'permission:toggleDebug'
const STOP_ACTION = 'footer:dismiss'

export const register: Register = (on, options) => {
  live.voice = String(options.voice ?? live.voice)
  config.language = String(options.language ?? config.language)
  config.whisperUrl = String(options.whisperUrl ?? config.whisperUrl)
  config.kokoroUrl = String(options.kokoroUrl ?? config.kokoroUrl)
  config.echoTailMs = tunable(options.echoTailMs, config.echoTailMs)
  config.vadEndSilenceMs = Math.max(1, Math.round(tunable(options.vadEndSilenceMs, config.vadEndSilenceMs)))
  config.vadStartFrames = Math.max(1, Math.round(tunable(options.vadStartFrames, config.vadStartFrames)))
  config.vadThresholdFactor = tunable(options.vadThresholdFactor, config.vadThresholdFactor)

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
    await update($, status, () => (was.isOn ? { ...was, queue: 0 } : { ...OFF, voice: live.voice }))
    $.clock.after(0, () => void recover($, was))
    await $.command.register({
      name: 'live',
      description: 'Hands-free voice conversation (local Whisper + Kokoro)',
      argumentHint: '[on|off|mute|status|voice <name>]',
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
        live.voice = command.voice
        await publish($)
        return { text: `Voice set to ${command.voice}.` }
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
    const { Box, Button, Text } = $.ui.resolve(e)
    const queued = now.queue > 0 ? ` · ${now.queue} queued` : ''
    const meter = now.meter ?? ''

    return (
      <Box>
        <Text>
          🎙 live · <Text bold>{now.state}</Text>
          {meter !== '' ? <Text color="cyan"> {meter}</Text> : null}
          <Text dimColor>{queued} · {now.voice} </Text>
        </Text>
        <Button
          key="mute"
          hotkey="m"
          action={MUTE_ACTION}
          label={live.isMuted ? 'Unmute' : 'Mute'}
          onPress={async () => {
            live.isMuted = !live.isMuted
            await writePause($)
            await publish($)
          }}
        />
        <Button key="stop" hotkey="s" action={STOP_ACTION} label="Stop" onPress={() => void silence($)} />
      </Box>
    )
  })
}
