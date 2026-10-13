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

const EDITOR_PANE = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 24 } } }

test('/live config <target> #hex sets a custom color the band draws; a theme key passes as-is', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const ui = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  expect((await $.command.run(live('config user #FF8800'))).text).toBe('user color set to #ff8800.')
  await settle(world)
  expect((await waveOf(ui))?.props.color).toBe('#ff8800')
  expect(world.store.get('colors')).toMatchObject({ user: '#ff8800' })

  expect((await $.command.run(live('config user planmode'))).text).toBe('user color set to planMode.')
  await settle(world)
  expect((await waveOf(ui))?.props.color).toBe('planMode')
  expect(world.store.get('colors')).toMatchObject({ user: 'planMode' })
  await ui.unmount()
  await $.command.run(live('off'))
})

test('a bad hex or an unknown color answers the usage with the kinds of color', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  for (const args of ['config user #12', 'config user #zzzzzz', 'config agent text']) {
    const ran = await $.command.run(live(args))
    expect(ran.text).toMatch(/#rrggbb/)
    expect(ran.text).toMatch(/claude\|success/)
  }
  expect(world.store.has('colors')).toBe(false)
})

test('the dialog builds a custom color with the R G B buttons in coarse and fine steps, and picks theme swatches', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('config'))
  const pane = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...EDITOR_PANE })
  const hotkeys: Record<string, string> = {
    'red-down': 'q', 'red-up': 'w', 'green-down': 'a', 'green-up': 's', 'blue-down': 'z', 'blue-up': 'x',
    'step-fine': '1', 'step-coarse': '2', 'test-voice': 't',
  }
  for (const [key, hotkey] of Object.entries(hotkeys)) {
    expect((await pane.find({ key }))?.props.hotkey).toBe(hotkey)
  }
  expect((await pane.find({ key: 'edit-target' }))?.props.value).toBe('user')
  await pane.select({ key: 'edit-target', value: 'agent' })
  await settle(world)
  expect((await pane.find({ key: 'edit-target' }))?.props.value).toBe('agent')

  // agent is cyan: the bars start at #00ffff; coarse steps are 16.
  await pane.press({ key: 'red-up' })
  await settle(world)
  expect(world.store.get('colors')).toMatchObject({ agent: '#10ffff', user: 'green' })
  await pane.press({ key: 'step-fine' })
  await pane.press({ key: 'green-down' })
  await pane.press({ key: 'blue-down' })
  await settle(world)
  expect(world.store.get('colors')).toMatchObject({ agent: '#10fefe' })
  await pane.press({ key: 'step-coarse' })
  await pane.press({ key: 'red-down' })
  await pane.press({ key: 'red-down' })
  await settle(world)
  expect(world.store.get('colors')).toMatchObject({ agent: '#00fefe' })
  const texts = (await pane.findAll({ type: 'Text' })).map(one => one.text)
  expect(texts.some(text => /^░{6,}$/.test(text))).toBe(true)
  expect(texts.some(text => /^█{6,}$/.test(text))).toBe(true)
  expect((await pane.find({ key: 'color-agent' }))?.props.value).toBe('#00fefe')

  await pane.press({ key: 'theme-success' })
  await settle(world)
  expect(world.store.get('colors')).toMatchObject({ agent: 'success' })
  await pane.unmount()
})
