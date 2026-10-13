import { expect, test } from 'claude-code/testing'

import type { Engine } from 'claude-code/testing'

import { waveRow } from '../hooks/text.ts'
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

const STEP = { index: 0, model: 'claude', messageCount: 1 }

type Found = { text: string; props: Record<string, unknown> }
type Ui = {
  find: (query: { type: string }) => Promise<Found | undefined>
  findAll: (query: { type: string }) => Promise<Found[]>
}

// The audio bar's wave: the band's one Text that is all block glyphs.
const waveOf = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).find(one => /^[▁-█]+$/.test(one.text))
const meterOf = async (ui: Ui) => (await waveOf(ui))?.text
// The audio bar's first Text: the live dot and the mic.
const micOf = async (ui: Ui) => await ui.find({ type: 'Text' })
// bodyColumns less the dot and mic (3 cells), `m: 🔇 Mute` (10), `s: ⏹ Stop`
// (10), the `│` (1), a gap after each of the four (4) and the margin (2).
// Muted, `🔇` (2) and `m: 🎙 Unmute` (12) take one cell more.
const WIDE = BAND.props.bodyColumns - 30
// Listening and nothing heard: a still flat line across the whole width.
const FLAT = new RegExp(`^▁{${WIDE}}$`)
// Every frame of the speaking wave at the band's width.
const WAVES = Array.from({ length: 8 }, (_, frame) => waveRow(frame, WIDE))
const HINT = 'alt+space mute · alt+s stop'

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

test('the band draws the speaking wave while the person talks, a flat line while silent, in their colors', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.reply.text = 'Hola.'
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  // Listening, nothing heard: a still flat line in the person's color (green).
  expect(await meterOf(ui)).toMatch(FLAT)
  expect((await waveOf(ui))?.props.color).toBe('green')
  // Silent listening does not redraw every tick: only the dot's blinks (about 4 in 2 s).
  const quiet = world.stateWrites()
  await settle(world, 2_000)
  expect(world.stateWrites() - quiet).toBeLessThanOrEqual(5)
  expect(await meterOf(ui)).toMatch(FLAT)
  // The person talks: exactly the speaking wave, moving, in green.
  world.levels(0.9, 1, 1)
  await settle(world)
  const loud = await meterOf(ui)
  expect(WAVES).toContain(loud)
  expect((await waveOf(ui))?.props.color).toBe('green')
  await settle(world, 260)
  const later = await meterOf(ui)
  expect(WAVES).toContain(later)
  expect(later).not.toBe(loud)
  // Once the voice stops, the line falls back to flat.
  world.levels(...Array.from({ length: 30 }, () => 0))
  await settle(world)
  expect(await meterOf(ui)).toMatch(FLAT)

  await liveTurn($, world)
  expect(await ui.find({ type: 'Text', text: 'speaking' })).toBeDefined()
  const first = await meterOf(ui)
  expect(WAVES).toContain(first)
  // The agent's voice is the same wave in cyan.
  expect((await waveOf(ui))?.props.color).toBe('cyan')
  await settle(world, 160)
  const second = await meterOf(ui)
  expect(WAVES).toContain(second)
  expect(second).not.toBe(first)

  world.playback.release()
  await settle(world)
  expect(await ui.find({ type: 'Text', text: 'listening' })).toBeDefined()
  expect(await meterOf(ui)).toMatch(FLAT)
  // Talking, the wave moves on the band's one timer: at most 8 redraws a second.
  world.levels(...Array.from({ length: 40 }, () => 1))
  const writes = world.stateWrites()
  await settle(world, 2_000)
  expect(world.stateWrites() - writes).toBeGreaterThan(4)
  expect(world.stateWrites() - writes).toBeLessThanOrEqual(17)
  await ui.unmount()
  await $.command.run(live('off'))
})

test('turning live voice off mid-reply stops the band timer', SLOW, async ($, on) => {
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

test('the audio bar holds the blinking mic, then the plain controls, then a wave filling the rest', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  const mute = await ui.find({ key: 'mute' })
  const stop = await ui.find({ key: 'stop' })
  expect(mute?.props).toMatchObject({ plain: true, hotkey: 'm', action: 'permission:toggleDebug', label: '🔇 Mute' })
  expect(stop?.props).toMatchObject({ plain: true, hotkey: 's', action: 'footer:dismiss', label: '⏹ Stop' })
  const bars = await ui.findAll({ type: 'Box' })
  // The band, then its audio bar (dot and mic, Mute, Stop, the bar, the wave), then the text bar.
  expect(bars[1]?.text).toMatch(/^(●| )🎙🔇 Mute⏹ Stop│[▁▂]+$/u)
  expect(bars[2]?.text).toBe(`listening · ef_dora${HINT}`)
  expect(await meterOf(ui)).toMatch(FLAT)

  // The dot blinks while on, in the dot color: lit and dark across a blink.
  expect((await micOf(ui))?.props.color).toBe('red')
  const before = (await micOf(ui))?.text.includes('●')
  await settle(world, 500)
  expect((await micOf(ui))?.text.includes('●')).toBe(!before)
  await settle(world, 500)
  expect((await micOf(ui))?.text.includes('●')).toBe(before)

  // Muted: a steady red muted mic, no dot, a flat dim wave, and nothing redraws.
  await ui.press({ key: 'mute' })
  await settle(world)
  expect((await ui.find({ key: 'mute' }))?.props.label).toBe('🎙 Unmute')
  expect((await micOf(ui))?.text).toBe('🔇')
  expect((await micOf(ui))?.props.color).toBe('red')
  const muted = world.stateWrites()
  await settle(world, 2_000)
  expect(world.stateWrites()).toBe(muted)
  expect(await meterOf(ui)).toBe('▁'.repeat(WIDE - 1))
  expect((await waveOf(ui))?.props).toMatchObject({ dimColor: true, color: 'gray' })

  // Narrow: the hint goes first; then the wave shrinks, and goes under 4 cells; the controls stay.
  await ui.redraw({ ...BAND.props, bodyColumns: 40 })
  expect(await ui.find({ type: 'Text', text: HINT })).toBeUndefined()
  expect(await meterOf(ui)).toBe('▁'.repeat(9))
  // 31 cells muted, 4 for the narrowest wave: one cell less and the wave goes.
  await ui.redraw({ ...BAND.props, bodyColumns: 34 })
  expect(await meterOf(ui)).toBeUndefined()
  expect(await ui.find({ key: 'mute' })).toBeDefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()

  // A band with room for one row keeps the audio bar and drops the text bar.
  await ui.redraw({ ...BAND.props, maxRows: 1 })
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: HINT })).toBeUndefined()
  expect((await ui.findAll({ type: 'Box' })).length).toBe(2)

  // Off, no blink timer survives: nothing is redrawn.
  await $.command.run(live('off'))
  await settle(world)
  const off = world.stateWrites()
  await settle(world, 2_000)
  expect(world.stateWrites()).toBe(off)
  await ui.unmount()
})

test('levels heard while not listening do not reach the next meter', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  await $.command.run(live('mute'))
  await settle(world)
  world.levels(1, 1, 1)
  await settle(world)
  await $.command.run(live('mute'))
  await settle(world)
  expect(await ui.find({ type: 'Text', text: 'listening' })).toBeDefined()
  expect(await meterOf(ui)).toMatch(FLAT)
  await ui.unmount()
  await $.command.run(live('off'))
})

test('a long run of loud levels keeps the wave as wide as the band and no level history in the state', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  world.levels(...Array.from({ length: 500 }, () => 1))
  await settle(world)
  expect(await meterOf(ui)).toHaveLength(WIDE)
  expect(await meterOf(ui)).toMatch(/[▇█]/)
  await ui.redraw({ ...BAND.props, bodyColumns: 330 })
  // A wider band is the same wave, wider: nothing pads it from a history.
  const wide = await meterOf(ui)
  expect(wide).toHaveLength(300)
  expect(wide?.slice(0, 100)).toMatch(/[▇█]/)
  // The state holds the current level, not the levels heard.
  const status = world.lastStatus() as Record<string, unknown>
  expect(status.levels).toBeUndefined()
  expect(status.level).toBeGreaterThan(0.9)
  await ui.unmount()
  await $.command.run(live('off'))
})
