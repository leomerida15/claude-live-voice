import { expect, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'

import { fakeWorld, settle } from './fake.ts'
import type { World } from './fake.ts'

const live = (args: string) => ({
  command: 'live',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 100 },
})

const SLOW = { timeoutMs: 30_000 }
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

test('the band buttons carry engine actions so a bound chord presses them from the prompt', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  expect((await ui.find({ key: 'mute' }))?.props.action).toBe('permission:toggleDebug')
  expect((await ui.find({ key: 'stop' }))?.props.action).toBe('footer:dismiss')
  await ui.unmount()
  await $.command.run(live('off'))
})

const STEP = { index: 0, model: 'claude', messageCount: 1 }

// The meter is the run of block glyphs in the band's status line.
const meterOf = async (ui: { find: (query: { type: string }) => Promise<{ text: string } | undefined> }) =>
  (await ui.find({ type: 'Box' }))?.text.match(/[▁-█]+/)?.[0]

// Hears one utterance and runs the live turn it starts, its reply held playing.
async function liveTurn($: Engine, world: World) {
  world.playback.hold = true
  world.hear('/run/user/1000/live-voice/utt-1.wav')
  await settle(world)
  await $.turn.start({ turnId: 't1', text: 'hola mundo' })
  for await (const _ of $.turn.step({ turnId: 't1', ...STEP })) {
    // Drain the step.
  }
  await $.turn.complete({ turnId: 't1', answer: world.reply.text, durationMs: 1, isAborted: false, reason: 'answer' })
  await settle(world, 50)
}

test('the band draws the microphone level while listening and a wave while speaking', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.reply.text = 'Hola.'
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  expect(await meterOf(ui)).toBe('▁▁▁▁▁▁▁▁')
  world.levels(0, 0.3, 1)
  await settle(world)
  expect(await meterOf(ui)).toBe('▁▁▁▁▁▁▃█')

  await liveTurn($, world)
  expect(await ui.find({ type: 'Text', text: 'speaking' })).toBeDefined()
  const first = await meterOf(ui)
  expect(first).toHaveLength(8)
  await settle(world, 160)
  const second = await meterOf(ui)
  expect(second).toHaveLength(8)
  expect(second).not.toBe(first)

  world.playback.release()
  await settle(world)
  expect(await ui.find({ type: 'Text', text: 'listening' })).toBeDefined()
  expect(await meterOf(ui)).toBe('▁▁▁▁▁▁▁▁')
  // The wave's timer stopped with the speech: idle, nothing is redrawn.
  const writes = world.stateWrites()
  await settle(world, 2_000)
  expect(world.stateWrites()).toBe(writes)
  await ui.unmount()
  await $.command.run(live('off'))
})

test('turning live voice off mid-reply stops the wave timer', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.reply.text = 'Hola.'
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  await liveTurn($, world)
  const speaking = world.stateWrites()
  await settle(world, 500)
  expect(world.stateWrites()).toBeGreaterThan(speaking)
  await $.command.run(live('off'))
  world.playback.release()
  await settle(world)
  const writes = world.stateWrites()
  await settle(world, 2_000)
  expect(world.stateWrites()).toBe(writes)
})
