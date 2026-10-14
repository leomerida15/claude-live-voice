// Replies to turns a system message started (a background task's
// notification, another session's message, a schedule, a channel) are spoken
// while live voice is on, after a short cue; typed turns stay silent.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SPOKEN_ORIGINS, noticeCue } from '../hooks/text.ts'
import { RUNTIME_DIR, SESSION_ID, fakeWorld, settle } from './fake.ts'
import type { World } from './fake.ts'

const live = (args: string) => ({
  command: 'live',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 100 },
})

const SLOW = { timeoutMs: 30_000 }
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const STEP = { index: 0, model: 'claude', messageCount: 1 }
const PAUSED = `${RUNTIME_DIR}/live-voice/${SESSION_ID}/paused`
const NOTIFICATION = '<task-notification>The agent finished.</task-notification>'

type Origin = Parameters<Engine['prompt']['submit']>[0]['origin']

const spoken = (world: World) =>
  world.spawns.filter(spawn => spawn.argv.some(arg => arg.endsWith('speak.sh'))).map(spawn => spawn.input)
const status = async ($: Engine) => (await $.command.run(live('status'))).text

async function liveOn($: Engine, world: World) {
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
}

// A prompt from `origin`, then the turn it starts streaming `reply`.
async function systemTurn($: Engine, world: World, origin: Origin, turnId: string, reply: string, text = NOTIFICATION) {
  await $.prompt.submit({ text, wait: false, origin })
  world.reply.text = reply
  await $.turn.start({ turnId, text })
  for await (const _ of $.turn.step({ turnId, ...STEP })) {
    // Drain the step.
  }
}

const complete = ($: Engine, turnId: string, answer: string) =>
  $.turn.complete({ turnId, answer, durationMs: 1, isAborted: false, reason: 'answer' })

describe('system origins', () => {
  test('the spoken set holds the system origins only', () => {
    expect([...SPOKEN_ORIGINS].sort()).toEqual(['channel', 'peer', 'peer-send-message', 'scheduled-trigger', 'task-notification'])
  })

  test('the cue is Spanish for Spanish, else English', () => {
    expect(noticeCue('es')).toBe('Aviso.')
    expect(noticeCue('ES')).toBe('Aviso.')
    expect(noticeCue('en')).toBe('Notice.')
    expect(noticeCue('')).toBe('Notice.')
  })
})

test('a task notification turn is spoken while live, the cue first', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await liveOn($, world)
  await systemTurn($, world, { kind: 'task-notification' }, 'n1', 'El agente terminó. Todo bien.')
  await complete($, 'n1', 'El agente terminó. Todo bien.')
  await settle(world)
  expect(spoken(world)).toEqual(['Aviso. El agente terminó.', 'Todo bien.'])
  // The notification entered unchanged, origin and all.
  expect(world.prompts.at(-1)).toMatchObject({ text: NOTIFICATION, origin: { kind: 'task-notification' } })
  await $.command.run(live('off'))
})

test('a peer message turn is spoken like a voice turn, the cue first', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await liveOn($, world)
  await systemTurn($, world, { kind: 'peer' }, 'p1', 'Otra sesión pregunta algo.', 'Another Claude session sent a message')
  await complete($, 'p1', 'Otra sesión pregunta algo.')
  await settle(world)
  expect(spoken(world)).toEqual(['Aviso. Otra sesión pregunta algo.'])
  await $.command.run(live('off'))
})

test('the cue is English when the session language is not Spanish', { ...SLOW, options: { language: 'en' } }, async ($, on) => {
  const world = fakeWorld(on)
  await liveOn($, world)
  await systemTurn($, world, { kind: 'scheduled-trigger' }, 's1', 'Done.', 'run the check')
  await complete($, 's1', 'Done.')
  await settle(world)
  expect(spoken(world)).toEqual(['Notice. Done.'])
  await $.command.run(live('off'))
})

test('a typed prompt with the same text stays silent', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await liveOn($, world)
  await systemTurn($, world, { kind: 'composer' }, 'c1', 'No hablo.')
  await complete($, 'c1', 'No hablo.')
  await settle(world)
  expect(spoken(world)).toEqual([])
  await $.command.run(live('off'))
})

test('another plugin\'s prompt stays silent', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await liveOn($, world)
  await systemTurn($, world, { kind: 'plugin', name: 'other', asUser: true } as Origin, 'o1', 'No hablo.')
  await complete($, 'o1', 'No hablo.')
  await settle(world)
  expect(spoken(world)).toEqual([])
  await $.command.run(live('off'))
})

test('with live voice off a task notification turn is silent', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await systemTurn($, world, { kind: 'task-notification' }, 'n1', 'El agente terminó.')
  await complete($, 'n1', 'El agente terminó.')
  await settle(world)
  expect(spoken(world)).toEqual([])
  // Turned on afterwards, a stale record does not make a later typed turn live.
  await $.command.run(live('on'))
  await settle(world)
  await systemTurn($, world, { kind: 'composer' }, 'c1', 'No hablo.')
  await complete($, 'c1', 'No hablo.')
  await settle(world)
  expect(spoken(world)).toEqual([])
  await $.command.run(live('off'))
})

test('a notification delivered into a running turn starts no live turn', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await liveOn($, world)
  await $.turn.start({ turnId: 'c1', text: 'escrito' })
  await $.prompt.submit({ text: NOTIFICATION, wait: false, origin: { kind: 'task-notification' }, turnId: 'c1' })
  expect(await status($)).toMatch(/: listening/)
  // The next typed turn is not claimed by a stale record either.
  await systemTurn($, world, { kind: 'composer' }, 'c2', 'No hablo.', 'otra cosa')
  await complete($, 'c2', 'No hablo.')
  await settle(world)
  expect(spoken(world)).toEqual([])
  await $.command.run(live('off'))
})

test('Esc on a system turn stops its speech like a voice turn', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await liveOn($, world)
  world.playback.hold = true
  await systemTurn($, world, { kind: 'task-notification' }, 'n1', 'Uno. Dos. Tres.')
  await settle(world)
  expect(await status($)).toMatch(/: speaking.*[12] sentence\(s\) queued/)
  await $.turn.complete({ turnId: 'n1', answer: 'Uno.', durationMs: 1, isAborted: true, reason: 'aborted' })
  await settle(world, 50)
  expect(await status($)).toMatch(/0 sentence\(s\) queued/)
  world.playback.release()
  await settle(world)
  expect(spoken(world)).toEqual(['Aviso. Uno.'])
  await $.command.run(live('off'))
})

test('speaking over a system turn aborts it like a voice turn', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await liveOn($, world)
  world.playback.hold = true
  await systemTurn($, world, { kind: 'task-notification' }, 'n1', 'Uno. Dos. Tres.')
  await settle(world)
  expect(world.files.get(PAUSED)).toBe('2')
  world.hear('barge')
  await settle(world)
  expect(world.aborts).toEqual(['n1'])
  expect(await status($)).toMatch(/: listening, voice \S+, 0 sentence\(s\) queued/)
  await $.command.run(live('off'))
  world.playback.release()
  await settle(world)
})
