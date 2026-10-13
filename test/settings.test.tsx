import { expect, test } from 'claude-code/testing'

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
  expect(shown).toMatch(/voice\s+Dora · Spanish · female \(ef_dora\)/)
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
  expect(ran.text).toMatch(/voice\s+Dora · Spanish · female \(ef_dora\)/)
  expect(ran.text).toMatch(/animation\s+wave/)
  expect(ran.text).toMatch(/silence\s+2000 ms/)
  expect(ran.text).toMatch(/user green.*agent cyan.*dot red.*idle gray/)
  expect(ran.text).toContain('/live config voice <name>')
  expect(ran.text).toContain('animation <wave|bars|off>')
})

test('the settings dialog lists Kokoro\'s voices by native language, Spanish first, the animations and the silences', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  await $.command.run(live('config'))
  const pane = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...PANE })
  const language = await pane.find({ key: 'voice-language' })
  expect((language?.props.options as { value: string }[]).map(option => option.value)).toEqual([
    'Spanish',
    'American English',
    'British English',
  ])
  expect(language?.props.value).toBe('Spanish')
  const voice = await pane.find({ key: 'voice' })
  const values = (voice?.props.options as { value: string }[]).map(option => option.value)
  expect(values).toEqual(['em_alex', 'ef_dora', 'em_santa'])
  const labels = (voice?.props.options as { label: string }[]).map(option => option.label)
  expect(labels).toEqual(['Alex (male)', 'Dora (female)', 'Santa (male)'])
  expect(voice?.props.value).toBe('ef_dora')
  const texts = (await pane.findAll({ type: 'Text' })).map(one => one.text)
  expect(texts.some(text => text.includes('Dora · Spanish · female (ef_dora)'))).toBe(true)
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
  expect(values.slice(0, 3)).toEqual(['em_alex', 'ef_dora', 'em_santa'])
  const languages = ((await pane.find({ key: 'voice-language' }))?.props.options as { value: string }[]).map(option => option.value)
  expect(languages[0]).toBe('Spanish')
  expect(languages.length).toBeGreaterThan(1)
  await pane.unmount()
})

const liveConfig = (args: string) => ({ ...live(args), command: 'live-config' })

test('/live-config opens the same settings dialog and takes the same shortcuts as /live config', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  const opened = await $.command.run(liveConfig(''))
  expect(world.opened).toContain('live-voice-config')
  expect(opened.text).toMatch(/voice\s+Dora · Spanish · female \(ef_dora\)/)
  expect((await $.command.run(liveConfig('voice em_alex'))).text).toBe('Voice set to em_alex.')
  expect((await $.command.run(liveConfig('silence 2500'))).text).toBe('End-of-speech silence set to 2500 ms.')
  expect((await $.command.run(liveConfig('dance'))).text).toMatch(/Usage/)
})

const PAUSED = `${RUNTIME_DIR}/live-voice/${SESSION_ID}/paused`
const STEP = { index: 0, model: 'claude', messageCount: 1 }
const speaks = (world: World) => world.spawns.filter(spawn => spawn.argv.some(arg => arg.endsWith('speak.sh')))

test('/live config test speaks a sample in the selected voice\'s language with the session tag, live off', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  const ran = await $.command.run(live('config test'))
  expect(ran.text).toBe('Testing voice Dora · Spanish · female (ef_dora).')
  await settle(world)
  expect(speaks(world)).toHaveLength(1)
  const spawn = speaks(world)[0]
  expect(spawn?.argv).toContain('ef_dora')
  expect(spawn?.argv.slice(-3)).toEqual(['--tag', 'live-voice-5f0c2a8e-1b7d-4c3e-9a10-2b3c4d5e6f70', 'ef_dora'])
  expect(spawn?.input).toBe('Hola, así suena esta voz.')

  await $.command.run(live('config voice af_heart'))
  await $.command.run(liveConfig('test'))
  await settle(world)
  expect(speaks(world)[1]?.input).toBe('Hi, this is how this voice sounds.')
  expect(speaks(world)[1]?.argv).toContain('af_heart')
})

test('the dialog\'s Test voice button speaks the sample and pauses the mic while live voice is on', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  world.playback.hold = true
  await $.command.run(live('config'))
  const pane = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...PANE })
  expect((await pane.find({ key: 'test-voice' }))?.props.hotkey).toBe('t')
  await pane.press({ key: 'test-voice' })
  await settle(world)
  expect(speaks(world)).toHaveLength(1)
  expect(speaks(world)[0]?.input).toBe('Hola, así suena esta voz.')
  expect(world.files.get(PAUSED)).toBe('1')
  world.playback.release()
  await settle(world)
  expect(world.files.get(PAUSED)).toBe('0')
  await pane.unmount()
  await $.command.run(live('off'))
})

test('/live config test answers busy while live voice is speaking and spawns nothing', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  world.hear('/run/user/1000/live-voice/utt-1.wav')
  await settle(world)
  world.playback.hold = true
  world.reply.text = 'Hola. Estoy bien.'
  await $.turn.start({ turnId: 't1', text: 'hola mundo' })
  for await (const _ of $.turn.step({ turnId: 't1', ...STEP })) {
    // Drain the step.
  }
  await settle(world)
  const before = speaks(world).length
  expect(before).toBe(1)
  expect((await $.command.run(live('config test'))).text).toMatch(/busy/i)
  await settle(world)
  expect(speaks(world)).toHaveLength(before)
  await $.command.run(live('off'))
  world.playback.release()
  await settle(world)
})
