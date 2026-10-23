// The optional Codex engine: `/live-config engine codex` makes `/live on`
// run the codex-live sidecar instead of listen.py, Whisper and Kokoro. The
// sidecar's delegations become Claude turns, and Claude's answers go back to
// it as commands (numbered JSON files in the session's runtime dir).

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  CODEX_VOICES,
  CONFIG_USAGE,
  ENGINES,
  codexCommandPath,
  codexControl,
  codexSettings,
  killPattern,
  parseLiveCommand,
  parseSidecarEvent,
  sessionTag,
  workStatus,
} from '../hooks/text.ts'
import { RUNTIME_DIR, SESSION_ID, fakeWorld, isSidecar, settle } from './fake.ts'
import type { World } from './fake.ts'

const live = (args: string) => ({
  command: 'live',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 100 },
})
const liveConfig = (args: string) => ({ ...live(''), command: 'live-config', args })

const SLOW = { timeoutMs: 30_000 }
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const STEP = { index: 0, model: 'claude', messageCount: 1 }
const DIR = `${RUNTIME_DIR}/live-voice/${SESSION_ID}`
const COMMANDS = `${DIR}/codex`
const NOT_SIGNED_IN = 'Codex: not signed in, run /live-config codex login'
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const sidecars = (world: World) => world.spawns.filter(spawn => isSidecar(spawn.argv) && spawn.argv.includes('run'))
const listeners = (world: World) => world.spawns.filter(spawn => spawn.argv.some(arg => arg.endsWith('listen.py')))
// The commands the mod wrote for the sidecar, in order.
const commands = (world: World) =>
  [...world.files.entries()]
    .filter(([path]) => path.startsWith(`${COMMANDS}/`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => JSON.parse(text) as Record<string, unknown>)
const status = async ($: Engine) => (await $.command.run(live('status'))).text

async function codexOn($: Engine, world: World) {
  world.store.set('engine', 'codex')
  await $.session.start(START)
  const answer = await $.command.run(live('on'))
  await settle(world)
  world.codex.send({ type: 'ready' })
  await settle(world)

  return answer
}

// A turn the engine starts from the prompt the plugin submitted, answering `reply`.
async function claudeTurn($: Engine, world: World, turnId: string, text: string, reply: string, tools = false) {
  world.reply.text = reply
  world.reply.tools = tools
  await $.turn.start({ turnId, text })
  for await (const _ of $.turn.step({ turnId, ...STEP })) {
    // Drain the step.
  }
}

const complete = ($: Engine, turnId: string, answer: string, aborted = false) =>
  $.turn.complete({ turnId, answer, durationMs: 1, isAborted: aborted, reason: aborted ? 'aborted' : 'answer' })

describe('codex helpers', () => {
  test('engines, voices and stored settings', () => {
    expect(ENGINES).toEqual(['local', 'codex'])
    expect(CODEX_VOICES).toEqual(['sol', 'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'])
    const defaults = { engine: 'local', codexVoice: 'sol' } as const
    expect(codexSettings({}, defaults)).toEqual(defaults)
    expect(codexSettings({ engine: 'codex', codexVoice: 'marin' }, defaults)).toEqual({ engine: 'codex', codexVoice: 'marin' })
    expect(codexSettings({ engine: 'cloud', codexVoice: 'ef_dora' }, defaults)).toEqual(defaults)
  })

  test('the config commands parse', () => {
    expect(parseLiveCommand('config engine codex')).toEqual({ kind: 'config-engine', engine: 'codex' })
    expect(parseLiveCommand('config engine LOCAL')).toEqual({ kind: 'config-engine', engine: 'local' })
    expect(parseLiveCommand('config codex login')).toEqual({ kind: 'config-codex', action: 'login' })
    expect(parseLiveCommand('config codex logout')).toEqual({ kind: 'config-codex', action: 'logout' })
    expect(parseLiveCommand('config codex status')).toEqual({ kind: 'config-codex', action: 'status' })
    expect(parseLiveCommand('config codex voice marin')).toEqual({ kind: 'config-codex-voice', voice: 'marin' })
    for (const bad of ['config engine cloud', 'config codex', 'config codex voice ef_dora', 'config codex login now']) {
      expect(parseLiveCommand(bad)).toEqual({ kind: 'error', message: CONFIG_USAGE })
    }
    expect(CONFIG_USAGE).toContain('engine <local|codex>')
    expect(CONFIG_USAGE).toContain('codex <login|logout|status|voice <name>>')
  })

  test('controls, events, command files, kill pattern, work status', () => {
    expect(codexControl('[[live:status]]')).toBe('status')
    expect(codexControl(' [[live:cancel-current]] ')).toBe('cancel')
    expect(codexControl('fix the bug [[live:status]]')).toBeUndefined()
    expect(parseSidecarEvent({ type: 'level', in: 0.5, out: 2 })).toEqual({ type: 'level', in: 0.5, out: 1 })
    expect(parseSidecarEvent({ type: 'delegation', id: 'd1', text: 'hi' })).toEqual({ type: 'delegation', id: 'd1', text: 'hi' })
    expect(parseSidecarEvent({ type: 'error', message: 'boom', code: 'signed-out' })).toEqual({ type: 'error', message: 'boom', code: 'signed-out' })
    expect(parseSidecarEvent({ type: 'ready' })).toEqual({ type: 'ready' })
    expect(parseSidecarEvent({ type: 'delegation', id: 3 })).toBeUndefined()
    expect(parseSidecarEvent({ type: 'nope' })).toBeUndefined()
    expect(codexCommandPath('/d', 7)).toBe('/d/00000007.json')
    expect(killPattern('codex-live/main.mjs', 'live-voice-x')).toBe('codex-live/main\\.mjs (.* )?--tag live-voice-x( |$)')
    expect(workStatus(0, 0)).toBe('No work is currently running or queued.')
    expect(workStatus(1, 0)).toBe("I'm still working on the current request. I haven't received a final result yet.")
    expect(workStatus(1, 2)).toBe("I'm still working on the current request. 2 requests are queued behind it. I haven't received a final result yet.")
    expect(workStatus(0, 1)).toBe('No request is currently running. 1 request is queued.')
  })
})

test('the engine is set with /live-config, kept, and shown', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  expect(await status($)).toMatch(/Engine local/)
  expect((await $.command.run(liveConfig('engine codex'))).text).toBe('Engine set to codex.')
  expect(world.store.get('engine')).toBe('codex')
  expect(await status($)).toMatch(/Engine codex/)
  expect((await $.command.run(liveConfig('codex voice marin'))).text).toBe('Codex voice set to marin.')
  expect(world.store.get('codexVoice')).toBe('marin')
  world.panes.isPlaced = false
  const summary = (await $.command.run(live('config'))).text
  expect(summary).toMatch(/engine\s+codex/)
  expect(summary).toMatch(/codex voice\s+marin/)
  await $.command.run(live('config reset'))
  expect(world.store.has('engine')).toBe(false)
  expect(await status($)).toMatch(/Engine local/)
})

test('engine codex: /live on spawns the sidecar instead of the listener', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.store.set('engine', 'codex')
  await $.session.start(START)
  expect((await $.command.run(live('on'))).text).toMatch(/Live voice on \(Codex\)/)
  await settle(world)
  expect(listeners(world)).toEqual([])
  expect(sidecars(world).map(spawn => spawn.argv.slice(2))).toEqual([
    ['run', '--tag', sessionTag(SESSION_ID), '--commands', COMMANDS, '--voice', 'sol', '--language', 'es', '--session-id', SESSION_ID],
  ])
  expect(sidecars(world)[0]?.argv[0]).toBe('node')
  expect(sidecars(world)[0]?.argv[1]).toMatch(/\/scripts\/codex-live\/main\.mjs$/)
  expect(await status($)).toMatch(/Live voice is on: connecting/)
  world.codex.send({ type: 'ready' })
  await settle(world)
  expect(await status($)).toMatch(/Live voice is on: listening, voice sol\. Engine codex/)
  await $.command.run(live('off'))
  expect(world.runs.some(argv => argv[0] === 'pkill' && argv.includes(killPattern('codex-live/main.mjs', sessionTag(SESSION_ID))))).toBe(true)
  expect(await status($)).toMatch(/Live voice is off/)
})

test('engine codex signed out: a toast, and live voice stays off', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.codex.status = 'signed-out'
  world.store.set('engine', 'codex')
  await $.session.start(START)
  expect((await $.command.run(live('on'))).text).toBe(NOT_SIGNED_IN)
  await settle(world)
  expect(world.toasts).toContain(NOT_SIGNED_IN)
  expect(sidecars(world)).toEqual([])
  expect(await status($)).toMatch(/Live voice is off/)
})

test('a delegation becomes a live Claude turn; its tool-step text is commentary, its answer the final', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await codexOn($, world)
  world.codex.send({ type: 'delegation', id: 'd1', text: 'arregla el test' })
  await settle(world)
  expect(world.prompts.at(-1)).toMatchObject({ text: 'arregla el test', origin: { kind: 'plugin', name: 'live-voice', asUser: true } })
  expect(await status($)).toMatch(/: thinking/)
  await claudeTurn($, world, 't1', 'arregla el test', 'Leo el archivo.', true)
  await claudeTurn($, world, 't1', 'arregla el test', 'Listo, el test pasa.')
  await complete($, 't1', 'Listo, el test pasa.')
  await settle(world)
  expect(commands(world)).toEqual([
    { type: 'commentary', id: 'd1', text: 'Leo el archivo.' },
    { type: 'final', id: 'd1', text: 'Listo, el test pasa.' },
  ])
  // Nothing goes to Kokoro.
  expect(world.spawns.filter(spawn => spawn.argv.some(arg => arg.endsWith('speak.sh')))).toEqual([])
  expect(await status($)).toMatch(/: listening/)
  await $.command.run(live('off'))
})

test('the status and cancel controls are answered without a Claude turn', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await codexOn($, world)
  world.codex.send({ type: 'delegation', id: 's1', text: '[[live:status]]' })
  await settle(world)
  expect(world.prompts).toEqual([])
  expect(commands(world)).toEqual([{ type: 'final', id: 's1', text: 'No work is currently running or queued.' }])
  // With a live turn running, cancel aborts it; its delegation is closed as stopped.
  world.codex.send({ type: 'delegation', id: 'd1', text: 'refactoriza todo' })
  await settle(world)
  await $.turn.start({ turnId: 't1', text: 'refactoriza todo' })
  world.codex.send({ type: 'delegation', id: 'c1', text: '[[live:cancel-current]]' })
  await settle(world)
  expect(world.aborts).toEqual(['t1'])
  await complete($, 't1', '', true)
  await settle(world)
  expect(commands(world).slice(1)).toEqual([
    { type: 'final', id: 'c1', text: 'I stopped the current operation.' },
    { type: 'cancel', id: 'd1' },
  ])
  await $.command.run(live('off'))
})

test('mute, the stop button and Esc reach the sidecar', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await codexOn($, world)
  expect((await $.command.run(live('mute'))).text).toBe('Microphone muted.')
  expect(await status($)).toMatch(/: muted/)
  await $.command.run(live('mute'))
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  await ui.press({ key: 'stop' })
  await ui.unmount()
  world.codex.send({ type: 'delegation', id: 'd1', text: 'hola' })
  await settle(world)
  await claudeTurn($, world, 't1', 'hola', 'Uno.')
  await complete($, 't1', 'Uno.', true)
  await settle(world)
  expect(commands(world)).toEqual([
    { type: 'mute', on: true },
    { type: 'mute', on: false },
    { type: 'cancel' },
    { type: 'cancel', id: 'd1' },
  ])
  await $.command.run(live('off'))
})

test('a system-triggered turn is sent as a notice', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await codexOn($, world)
  const text = '<task-notification>The agent finished.</task-notification>'
  await $.prompt.submit({ text, wait: false, origin: { kind: 'task-notification' } })
  await claudeTurn($, world, 'n1', text, 'El agente terminó.')
  await complete($, 'n1', 'El agente terminó.')
  await settle(world)
  expect(commands(world)).toEqual([{ type: 'notice', text: 'El agente terminó.' }])
  await $.command.run(live('off'))
})

test('the band follows the sidecar levels: the person in the user color, Claude in the agent color', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await codexOn($, world)
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  world.codex.send({ type: 'level', in: 0, out: 0.5 })
  await settle(world)
  expect(await ui.find({ type: 'Text', text: /^speaking · sol/ })).toBeDefined()
  world.codex.send({ type: 'level', in: 0.4, out: 0 })
  await settle(world)
  expect(await ui.find({ type: 'Text', text: /^listening · sol/ })).toBeDefined()
  await ui.unmount()
  await $.command.run(live('off'))
})

test('sidecar errors are toasts; its end turns live voice off', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await codexOn($, world)
  world.codex.send({ type: 'error', message: 'Codex live signaling failed (403): forbidden' })
  await settle(world)
  expect(world.toasts).toContain('live-voice: Codex live signaling failed (403): forbidden')
  world.codex.end()
  await settle(world)
  expect(world.toasts.at(-1)).toBe('live-voice: the Codex session ended; /live on to start it again')
  expect(await status($)).toMatch(/Live voice is off/)
})

test('codex login runs the sidecar login and reports its progress as toasts; status and logout answer', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.codex.status = 'signed-out'
  world.codex.login = [
    { type: 'url', url: 'https://auth.openai.com/oauth/authorize?x=1' },
    { type: 'progress', message: 'Opening the browser to sign in with ChatGPT.' },
    { type: 'done', message: 'Signed in to Codex.' },
  ]
  await $.session.start(START)
  expect((await $.command.run(liveConfig('codex login'))).text).toMatch(/sign-in started/i)
  await settle(world)
  expect(world.spawns.some(spawn => isSidecar(spawn.argv) && spawn.argv.at(-1) === 'login')).toBe(true)
  expect(world.toasts).toEqual([
    'Codex: if the browser did not open, visit https://auth.openai.com/oauth/authorize?x=1',
    'Codex: Opening the browser to sign in with ChatGPT.',
    'Codex: Signed in to Codex.',
  ])
  world.codex.status = 'signed-in'
  expect((await $.command.run(liveConfig('codex status'))).text).toMatch(/^Codex: signed in/)
  expect((await $.command.run(liveConfig('codex logout'))).text).toBe('Codex: signed out.')
  expect((await $.command.run(liveConfig('codex status'))).text).toBe('Codex: signed out. Sign in with /live-config codex login.')
})

test('the local engine is unchanged: no sidecar, no command files', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  expect(listeners(world).length).toBe(1)
  expect(sidecars(world)).toEqual([])
  expect(commands(world)).toEqual([])
  await $.command.run(live('off'))
})

test('a hot reload with codex on kills the orphan sidecar and starts a new one', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await codexOn($, world)
  await $.session.start(START)
  await settle(world)
  expect(world.runs.some(argv => argv[0] === 'pkill' && argv.includes(killPattern('codex-live/main.mjs', sessionTag(SESSION_ID))))).toBe(true)
  expect(sidecars(world).length).toBe(2)
  await $.command.run(live('off'))
})
