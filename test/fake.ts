// The world beneath the live-voice mod in engine tests: processes, files,
// the session id, the clock and the model's reply, all in memory.

import type { On, ProcessSpawnRequest, PromptSubmitInput } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

export const SESSION_ID = '5f0c2a8e-1b7d-4c3e-9a10-2b3c4d5e6f70'
export const RUNTIME_DIR = '/run/user/1000'

export type World = {
  /** argv of every `$.process.run`, oldest first. */
  runs: string[][]
  /** Every `$.process.spawn` request, oldest first. */
  spawns: ProcessSpawnRequest[]
  /** What `$.fs.write` wrote last, by path. */
  files: Map<string, string>
  /** Prompts that reached the bottom of `prompt.submit`. */
  prompts: PromptSubmitInput[]
  clock: MockClock
  /** The listener prints this WAV path, as if an utterance was heard. */
  hear: (wav: string) => void
  /** The listener prints these meter levels, as it does while listening. */
  levels: (...values: number[]) => void
  /** While true, speak.sh children play until `release` is called. */
  playback: { hold: boolean; release: () => void }
  /** How many `$.state` writes the plugin made: an idle mod makes none. */
  stateWrites: () => number
  /** The `status` value the plugin wrote last to `$.state`. */
  lastStatus: () => unknown
  /** The text the model streams for the next turn.step. */
  reply: { text: string }
  /** The plugin's `$.store`, kept across sessions: seed it to stand for an earlier one. */
  store: Map<string, unknown>
  /** The ids of the panes the plugin opened, oldest first. */
  opened: string[]
}

/**
 * Lets pending work run: detached hook work and the pause after playback
 * (`ms` of mocked time).
 */
export async function settle(world: World, ms = 400) {
  await world.clock.advance(ms)
}

export function fakeWorld(on: On, transcript = 'hola mundo'): World {
  const heard: string[] = []
  let wake = () => {}
  let releases: (() => void)[] = []
  let stateWrites = 0
  let lastStatus: unknown
  const world: World = {
    runs: [],
    spawns: [],
    files: new Map(),
    prompts: [],
    clock: undefined as unknown as MockClock,
    hear: wav => {
      heard.push(wav)
      wake()
    },
    levels: (...values) => {
      heard.push(...values.map(value => `level ${value.toFixed(2)}`))
      wake()
    },
    playback: {
      hold: false,
      release: () => {
        const held = releases
        releases = []
        for (const release of held) release()
      },
    },
    stateWrites: () => stateWrites,
    lastStatus: () => lastStatus,
    reply: { text: '' },
    store: new Map(),
    opened: [],
  }
  on('state.set', (_$, e, next) => {
    stateWrites += 1
    if (e.key === 'status') lastStatus = e.value

    return next(e)
  })
  world.clock = mock.clock(on)
  mock.env(on, { XDG_RUNTIME_DIR: RUNTIME_DIR })
  on('session.id', () => ({ value: SESSION_ID }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', (_$, e) => {
    world.files.set(e.path, e.text)

    return { value: undefined }
  })
  on('store.get', (_$, e) => ({ value: world.store.get(e.key) }))
  on('store.set', (_$, e) => {
    world.store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    world.opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('process.run', (_$, e) => {
    world.runs.push([...e.argv])
    const stdout = e.argv[0] === 'curl' ? JSON.stringify({ text: transcript }) : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_$, e) {
    world.spawns.push(e)
    if (e.argv.some(arg => arg.endsWith('listen.py'))) {
      for (;;) {
        const wav = heard.shift()
        if (wav === undefined) {
          await new Promise<void>(resolve => {
            wake = resolve
          })
          continue
        }
        yield { stream: 'stdout' as const, text: `${wav}\n` }
      }
    }
    if (world.playback.hold && e.argv.some(arg => arg.endsWith('speak.sh'))) {
      await new Promise<void>(resolve => releases.push(resolve))
    }

    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', (_$, e) => {
    world.prompts.push(e)

    return { text: e.text, origin: e.origin }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text' as const, index: 0, text: world.reply.text }

    return {
      turnId: e.turnId,
      index: e.index,
      answer: world.reply.text,
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: null,
    }
  })

  return world
}
