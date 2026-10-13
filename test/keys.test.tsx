import { expect, test } from 'claude-code/testing'

import { KEYBINDINGS, fakeWorld, settle } from './fake.ts'

const SLOW = { timeoutMs: 30_000 }
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const MUTE = 'permission:toggleDebug'
const STOP = 'footer:dismiss'
const live = (args: string) => ({
  command: 'live',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 100 },
})
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const
const PANE = {
  component: 'Pane',
  requestId: 'live-voice-config',
  props: { title: 'Live voice settings', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('setting the mute chord rewrites only the two action entries, keeps the rest and backs up the old file', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  const before = JSON.stringify({
    $docs: 'https://code.claude.com/docs/en/keybindings',
    bindings: [
      { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor', 'alt+space': MUTE } },
      { context: 'Global', bindings: { 'alt+s': STOP } },
    ],
  })
  world.files.set(KEYBINDINGS, before)
  await $.session.start(START)
  const ran = await $.command.run(live('config mute alt+q'))
  expect(ran.text).toMatch(/alt\+q/)
  expect(world.files.get(`${KEYBINDINGS}.live-voice.bak`)).toBe(before)
  expect(JSON.parse(world.files.get(KEYBINDINGS) ?? '')).toEqual({
    $docs: 'https://code.claude.com/docs/en/keybindings',
    bindings: [
      { context: 'Chat', bindings: { 'ctrl+e': 'chat:externalEditor' } },
      { context: 'Global', bindings: { 'meta+q': MUTE, 'meta+s': STOP } },
    ],
  })
  expect(world.store.get('chords')).toEqual({ mute: 'meta+q', stop: 'meta+s' })
  expect((await $.command.run(live('config keys'))).text).toMatch(/mute alt\+q.*stop alt\+s/s)
})

test('a keybindings file that is not JSON is never written and the answer says why', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.files.set(KEYBINDINGS, '{ "bindings": [ oops')
  await $.session.start(START)
  const ran = await $.command.run(live('config stop ctrl+]'))
  expect(ran.text).toMatch(/not valid JSON/)
  expect(world.files.get(KEYBINDINGS)).toBe('{ "bindings": [ oops')
  expect(world.files.has(`${KEYBINDINGS}.live-voice.bak`)).toBe(false)
  expect(world.store.has('chords')).toBe(false)
})

test('a missing keybindings file is created by keys apply; mute and stop must differ', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  expect(world.files.has(KEYBINDINGS)).toBe(false)
  await $.command.run(live('config keys apply'))
  expect(JSON.parse(world.files.get(KEYBINDINGS) ?? '')).toEqual({ bindings: [{ context: 'Global', bindings: { 'meta+m': MUTE, 'meta+s': STOP } }] })
  expect(world.files.has(`${KEYBINDINGS}.live-voice.bak`)).toBe(false)
  const same = await $.command.run({ ...live('config stop alt+m'), command: 'live-config', args: 'stop alt+m' })
  expect(same.text).toMatch(/differ/)
})

test('the band hint follows the chords and the dialog offers them in two Selects', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const band = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: 'alt+m mute · alt+s stop' })).toBeDefined()
  await $.command.run(live('config stop ctrl+]'))
  await settle(world)
  expect(await band.find({ type: 'Text', text: 'alt+m mute · ctrl+] stop' })).toBeDefined()
  await band.unmount()

  await $.command.run(live('config'))
  const pane = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...PANE })
  const mute = await pane.find({ key: 'chord-mute' })
  const stop = await pane.find({ key: 'chord-stop' })
  expect(mute?.props.value).toBe('meta+m')
  expect(stop?.props.value).toBe('ctrl+]')
  for (const select of [mute, stop]) {
    const options = (select?.props.options ?? []) as { value: string; label?: string }[]
    expect(options.length).toBeGreaterThan(1)
    expect(options.length).toBeLessThanOrEqual(64)
    expect(options.find(option => option.value === 'meta+m')?.label).toBe('alt+m')
  }
  await pane.select({ key: 'chord-mute', value: 'meta+x' })
  await settle(world)
  expect(world.store.get('chords')).toEqual({ mute: 'meta+x', stop: 'ctrl+]' })
  expect(JSON.parse(world.files.get(KEYBINDINGS) ?? '').bindings[0].bindings).toEqual({ 'meta+x': MUTE, 'ctrl+]': STOP })
  await pane.unmount()
  await $.command.run(live('off'))
})
