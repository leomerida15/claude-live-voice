import { expect, test } from 'claude-code/testing'

import { fakeWorld, settle } from './fake.ts'

// The 67 voices a real Kokoro lists at `/v1/audio/voices`: more than a Select takes (64).
const KOKORO_VOICES = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jadzia', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova',
  'af_river', 'af_sarah', 'af_sky', 'af_v0', 'af_v0bella', 'af_v0irulan', 'af_v0nicole', 'af_v0sarah', 'af_v0sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'am_v0adam', 'am_v0gurney', 'am_v0michael', 'bf_alice', 'bf_emma', 'bf_lily', 'bf_v0emma', 'bf_v0isabella',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis', 'bm_v0george', 'bm_v0lewis', 'ef_dora', 'em_alex', 'em_santa',
  'ff_siwis', 'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi', 'if_sara', 'im_nicola', 'jf_alpha', 'jf_gongitsune',
  'jf_nezumi', 'jf_tebukuro', 'jm_kumo', 'pf_dora', 'pm_alex', 'pm_santa', 'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao',
  'zf_xiaoyi', 'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
]

const SLOW = { timeoutMs: 30_000 }
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
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
const config = (args: string) => ({
  command: 'live',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 100 },
})

type Option = { value: string; label?: string }
const optionsOf = (found: { props: Record<string, unknown> } | undefined) => (found?.props.options ?? []) as Option[]

test('with the real 67 Kokoro voices the dialog draws its own tree, every Select within 64 options', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.voices.list = [...KOKORO_VOICES]
  await $.session.start(START)
  await $.command.run(config('config'))
  const pane = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...PANE })
  // The plugin's own tree: its keyed elements are there, not the engine's fallback.
  expect(await pane.find({ key: 'voice' })).toBeDefined()
  expect(await pane.find({ key: 'test-voice' })).toBeDefined()
  const selects = await pane.findAll({ type: 'Select' })
  expect(selects.length).toBeGreaterThan(0)
  for (const select of selects) {
    const options = optionsOf(select)
    expect(options.length).toBeGreaterThanOrEqual(1)
    expect(options.length).toBeLessThanOrEqual(64)
    expect(new Set(options.map(option => option.value)).size).toBe(options.length)
  }
  await pane.unmount()
})

test('the voice picker is two steps: a language, then that language\'s voices', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.voices.list = [...KOKORO_VOICES]
  await $.session.start(START)
  await $.command.run(config('config'))
  const pane = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...PANE })
  const language = await pane.find({ key: 'voice-language' })
  expect(optionsOf(language).map(option => option.value)).toEqual([
    'Spanish',
    'American English',
    'Brazilian Portuguese',
    'British English',
    'French',
    'Hindi',
    'Italian',
    'Japanese',
    'Mandarin Chinese',
  ])
  expect(language?.props.value).toBe('Spanish')
  const spanish = optionsOf(await pane.find({ key: 'voice' }))
  expect(spanish).toEqual([
    { value: 'em_alex', label: 'Alex (male)' },
    { value: 'ef_dora', label: 'Dora (female)' },
    { value: 'em_santa', label: 'Santa (male)' },
  ])

  // Picking a language lists its voices and leaves the voice as it was.
  await pane.select({ key: 'voice-language', value: 'American English' })
  await settle(world)
  expect((await pane.find({ key: 'voice-language' }))?.props.value).toBe('American English')
  const american = optionsOf(await pane.find({ key: 'voice' }))
  expect(american).toHaveLength(30)
  expect(american[0]).toEqual({ value: 'am_adam', label: 'Adam (male)' })
  expect(american.every(option => option.value.startsWith('a'))).toBe(true)
  expect(world.store.has('voice')).toBe(false)
  expect((await $.command.run(config('status'))).text).toMatch(/Voice ef_dora/)

  // Picking a voice sets it.
  await pane.select({ key: 'voice', value: 'af_heart' })
  await settle(world)
  expect(world.store.get('voice')).toBe('af_heart')
  expect((await pane.find({ key: 'voice' }))?.props.value).toBe('af_heart')
  const texts = (await pane.findAll({ type: 'Text' })).map(one => one.text)
  expect(texts.some(text => text.includes('Heart · American English · female (af_heart)'))).toBe(true)
  await pane.unmount()
})
