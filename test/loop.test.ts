import { expect, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import { fakeWorld, settle } from './fake.ts'
import type { World } from './fake.ts'

const live = (args: string) => ({
  command: 'live',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 100 },
})

// Each settle waits for the engine to go quiet, about a second of real time.
const SLOW = { timeoutMs: 30_000 }
const STEP = { index: 0, model: 'claude', messageCount: 1 }

// Another plugin beneath live-voice that rewrites every prompt.
const rewriter: Plugin = {
  name: 'rewriter',
  tier: 'builtin',
  register: on => {
    on('prompt.submit', ($, e, next) => next({ ...e, text: `${e.text} (rewritten)` }))
  },
}

const spoken = (world: World) =>
  world.spawns.filter(spawn => spawn.argv.some(arg => arg.endsWith('speak.sh'))).map(spawn => spawn.input)

// Runs one model turn: start, one streamed step, completion.
async function turn($: Engine, world: World, turnId: string, text: string, reply: string) {
  world.reply.text = reply
  await $.turn.start({ turnId, text })
  const stream = $.turn.step({ turnId, ...STEP })
  for await (const _ of stream) {
    // Drain the step.
  }
  await $.turn.complete({ turnId, answer: reply, durationMs: 1, isAborted: false, reason: 'answer' })
  await settle(world)
}

test('a transcript the plugin submitted is a live turn even when another plugin rewrites it', { ...SLOW, plugins: [rewriter] }, async ($, on) => {
  const world = fakeWorld(on, 'hola mundo')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.command.run(live('on'))
  await settle(world)
  world.hear('/run/user/1000/live-voice/utt-1.wav')
  await settle(world)
  expect(world.prompts).toHaveLength(1)
  expect(world.prompts[0]?.text).toBe('hola mundo (rewritten)')
  expect(world.prompts[0]?.origin).toMatchObject({ kind: 'plugin', name: 'live-voice' })

  await turn($, world, 't1', 'hola mundo (rewritten)', 'Hola. Estoy bien.')
  expect(spoken(world)).toEqual(['Hola.', 'Estoy bien.'])
  await $.command.run(live('off'))
})

test('a typed prompt with the same text as a transcript is not a live turn', SLOW, async ($, on) => {
  const world = fakeWorld(on, 'hola mundo')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.command.run(live('on'))
  await settle(world)
  await $.prompt.submit({ text: 'hola mundo', wait: false, origin: { kind: 'composer' } })

  await turn($, world, 't1', 'hola mundo', 'No hablo.')
  expect(spoken(world)).toEqual([])
  await $.command.run(live('off'))
})

test('queued live prompts merged into one turn still make it a live turn', SLOW, async ($, on) => {
  const world = fakeWorld(on, 'hola')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.command.run(live('on'))
  await settle(world)
  world.hear('/run/user/1000/live-voice/utt-1.wav')
  await settle(world)

  await turn($, world, 't1', 'hola\nadiós', 'Dos cosas.')
  expect(spoken(world)).toEqual(['Dos cosas.'])
  await $.command.run(live('off'))
})

test('the pause after playback follows the echoTailMs setting', { ...SLOW, options: { echoTailMs: 1000 } }, async ($, on) => {
  const world = fakeWorld(on, 'hola')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.command.run(live('on'))
  await settle(world)
  world.hear('/run/user/1000/live-voice/utt-1.wav')
  await settle(world)

  // turn() lets 400 ms pass after the reply: still inside the 1000 ms tail.
  await turn($, world, 't1', 'hola', 'Hola.')
  expect(spoken(world)).toEqual(['Hola.'])
  expect((await $.command.run(live('status'))).text).toMatch(/: speaking/)
  await settle(world, 700)
  expect((await $.command.run(live('status'))).text).toMatch(/: listening/)
  await $.command.run(live('off'))
})
