import { expect, test } from 'claude-code/testing'

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
const PANE = {
  component: 'Pane',
  requestId: 'live-voice-config',
  props: {
    title: 'Live voice settings',
    isFocused: true,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 14 },
    view: {},
  },
} as const

type Found = { text: string; props: Record<string, unknown> }
type Ui = { findAll: (query: { type: string }) => Promise<Found[]> }

// The audio bar's wave: the Text after the `│` separator.
const waveOf = async (ui: Ui) => {
  const texts = await ui.findAll({ type: 'Text' })
  const bar = texts.findIndex(one => one.text === '│')

  return bar >= 0 ? texts[bar + 1] : undefined
}

const listeners = (world: World) => world.spawns.filter(spawn => spawn.argv.some(arg => arg.endsWith('listen.py')))
const endSilence = (world: World, index: number) => {
  const argv = listeners(world)[index]?.argv ?? []

  return argv[argv.indexOf('--end-silence-ms') + 1]
}

test('/live config animation bars draws bars, off a still dim line, and both are kept', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  expect((await waveOf(ui))?.text).toMatch(/^[▁▂]+$/)

  expect((await $.command.run(live('config animation bars'))).text).toBe('Animation set to bars.')
  world.levels(1, 1, 1)
  await settle(world)
  const bars = await waveOf(ui)
  expect(bars?.text).toMatch(/^[▁-█]( [▁-█])+ ?$/)
  expect(bars?.text).toMatch(/[▅▆▇█]/)
  expect(bars?.props.color).toBe('green')
  expect(world.store.get('animation')).toBe('bars')

  expect((await $.command.run(live('config animation off'))).text).toBe('Animation set to off.')
  await settle(world)
  const still = await waveOf(ui)
  expect(still?.text).toMatch(/^▁+$/)
  expect(still?.props).toMatchObject({ dimColor: true })
  // Off: listening moves nothing, only the dot blinks (twice a second).
  const writes = world.stateWrites()
  await settle(world, 2_000)
  expect(world.stateWrites() - writes).toBeLessThanOrEqual(5)
  expect(world.store.get('animation')).toBe('off')
  await ui.unmount()
  await $.command.run(live('off'))
})

test('/live config silence restarts the listener with the new end-of-speech silence and keeps it', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  expect(endSilence(world, 0)).toBe('2000')
  const killsBefore = world.runs.filter(argv => argv[0] === 'pkill').length

  expect((await $.command.run(live('config silence 3000'))).text).toBe('End-of-speech silence set to 3000 ms.')
  await settle(world)
  expect(listeners(world)).toHaveLength(2)
  expect(endSilence(world, 1)).toBe('3000')
  const kills = world.runs.filter(argv => argv[0] === 'pkill').slice(killsBefore)
  expect(kills.some(argv => (argv[argv.length - 1] ?? '').startsWith('listen'))).toBe(true)
  expect(world.store.get('silenceMs')).toBe(3000)
  // Still listening, with no "listener stopped" fallout.
  expect((await $.command.run(live('status'))).text).toMatch(/Live voice is on: listening/)
  await $.command.run(live('off'))
})

test('/live config silence while off spawns nothing and the next start uses it', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.store.set('silenceMs', 1000)
  await $.session.start(START)
  await settle(world)
  await $.command.run(live('on'))
  await settle(world)
  expect(endSilence(world, 0)).toBe('1000')
  await $.command.run(live('off'))
  await $.command.run(live('config silence 2500'))
  await settle(world)
  expect(listeners(world)).toHaveLength(1)
  await $.command.run(live('on'))
  await settle(world)
  expect(endSilence(world, 1)).toBe('2500')
  await $.command.run(live('off'))
})

test('/live config voice sets the voice and keeps it for later sessions', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.store.set('voice', 'em_santa')
  await $.session.start(START)
  expect((await $.command.run(live('status'))).text).toMatch(/Voice em_santa/)
  expect((await $.command.run(live('config voice em_alex'))).text).toBe('Voice set to em_alex.')
  expect(world.store.get('voice')).toBe('em_alex')
  expect((await $.command.run(live('status'))).text).toMatch(/Voice em_alex/)
})

test('/live config reset restores every setting', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.store.set('voice', 'em_santa')
  world.store.set('animation', 'off')
  world.store.set('silenceMs', 3000)
  await $.session.start(START)
  await $.command.run(live('config reset'))
  expect(world.store.has('voice')).toBe(false)
  expect(world.store.has('animation')).toBe(false)
  expect(world.store.has('silenceMs')).toBe(false)
  const shown = (await $.command.run(live('config'))).text
  expect(shown).toMatch(/voice\s+ef_dora/)
  expect(shown).toMatch(/animation\s+wave/)
  expect(shown).toMatch(/silence\s+2000 ms/)
})

test('/live config answers every setting and the shortcuts when the dialog cannot be placed', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.panes.isPlaced = false
  await $.session.start(START)
  const ran = await $.command.run(live('config'))
  expect(world.opened).toContain('live-voice-config')
  expect(ran.text).toMatch(/could not open/i)
  expect(ran.text).toMatch(/voice\s+ef_dora/)
  expect(ran.text).toMatch(/animation\s+wave/)
  expect(ran.text).toMatch(/silence\s+2000 ms/)
  expect(ran.text).toMatch(/user green.*agent cyan.*dot red.*idle gray/)
  expect(ran.text).toContain('/live config voice <name>')
  expect(ran.text).toContain('animation <wave|bars|off>')
})

test('the settings dialog lists Kokoro\'s voices Spanish first, the animations and the silences', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  await $.command.run(live('config'))
  const pane = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...PANE })
  const voice = await pane.find({ key: 'voice' })
  const values = (voice?.props.options as { value: string }[]).map(option => option.value)
  expect(values).toEqual(['ef_dora', 'em_alex', 'em_santa', 'af_heart', 'bm_george'])
  expect(voice?.props.value).toBe('ef_dora')
  expect((await pane.find({ key: 'animation' }))?.props.value).toBe('wave')
  const silence = await pane.find({ key: 'silence' })
  expect((silence?.props.options as { value: string }[]).map(option => option.value)).toEqual(['1000', '1500', '2000', '2500', '3000'])
  expect(silence?.props.value).toBe('2000')

  await pane.select({ key: 'voice', value: 'em_alex' })
  await pane.select({ key: 'animation', value: 'bars' })
  await pane.select({ key: 'silence', value: '1500' })
  await settle(world)
  expect(world.store.get('voice')).toBe('em_alex')
  expect(world.store.get('animation')).toBe('bars')
  expect(world.store.get('silenceMs')).toBe(1500)
  expect(endSilence(world, 1)).toBe('1500')
  await pane.unmount()
  await $.command.run(live('off'))
})

test('the settings dialog falls back to a built-in voice list when Kokoro does not answer', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.voices.list = undefined
  await $.session.start(START)
  await $.command.run(live('config'))
  const pane = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...PANE })
  const values = ((await pane.find({ key: 'voice' }))?.props.options as { value: string }[]).map(option => option.value)
  expect(values.slice(0, 3)).toEqual(['ef_dora', 'em_alex', 'em_santa'])
  expect(values.length).toBeGreaterThan(3)
  await pane.unmount()
})
