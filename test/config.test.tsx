import { expect, test } from 'claude-code/testing'

import { fakeWorld, settle } from './fake.ts'

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
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type Found = { text: string; props: Record<string, unknown> }
type Ui = { findAll: (query: { type: string }) => Promise<Found[]> }

// The audio bar's wave: the band's one Text that is all block glyphs.
const waveOf = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).find(one => /^[▁-█]+$/.test(one.text))

test('/live config <target> <color> sets one color, the band follows and it is kept', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  expect((await waveOf(ui))?.props.color).toBe('green')
  const ran = await $.command.run(live('config user magenta'))
  expect(ran.text).toBe('user color set to magenta.')
  await settle(world)
  expect((await waveOf(ui))?.props.color).toBe('magenta')
  expect(world.store.get('colors')).toMatchObject({ user: 'magenta', agent: 'cyan', dot: 'red', idle: 'gray' })
  await ui.unmount()
  await $.command.run(live('off'))
})

test('/live config reset restores the default colors', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.store.set('colors', { user: 'blue', agent: 'yellow', dot: 'white', idle: 'blue' })
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  // Kept from an earlier session.
  expect((await waveOf(ui))?.props.color).toBe('blue')
  const ran = await $.command.run(live('config reset'))
  expect(ran.text).toBe('Settings restored to the defaults.')
  await settle(world)
  expect((await waveOf(ui))?.props.color).toBe('green')
  expect(world.store.get('colors')).toEqual({ user: 'green', agent: 'cyan', dot: 'red', idle: 'gray' })
  await ui.unmount()
  await $.command.run(live('off'))
})

test('a bad /live config answers the usage with the valid values and changes nothing', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  for (const args of ['config agent pink', 'config mic red', 'config user']) {
    const ran = await $.command.run(live(args))
    expect(ran.text).toMatch(/user\|agent\|dot\|idle/)
    expect(ran.text).toMatch(/red\|green\|yellow\|blue\|magenta\|cyan\|white\|gray/)
  }
  expect(world.store.has('colors')).toBe(false)
})

test('/live config opens the settings dialog; a pick persists and Restore resets', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  const ran = await $.command.run(live('config'))
  expect(ran.text).toMatch(/settings/i)
  expect(world.opened).toContain('live-voice-config')
  const pane = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...PANE })
  for (const key of ['color-user', 'color-agent', 'color-dot', 'color-idle']) {
    expect(await pane.find({ key })).toBeDefined()
  }
  expect((await pane.find({ key: 'color-agent' }))?.props.value).toBe('cyan')
  await pane.select({ key: 'color-agent', value: 'yellow' })
  await settle(world)
  expect(world.store.get('colors')).toMatchObject({ agent: 'yellow' })
  expect((await pane.find({ key: 'color-agent' }))?.props.value).toBe('yellow')
  await pane.press({ key: 'restore' })
  await settle(world)
  expect(world.store.get('colors')).toMatchObject({ agent: 'cyan' })
  expect(await pane.find({ key: 'close' })).toBeDefined()
  await pane.unmount()
})
