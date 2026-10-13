import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

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
const PANE = {
  component: 'Pane',
  requestId: 'live-voice-config',
  props: {
    title: 'Live voice settings',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 14 },
    view: {},
  },
} as const

const listeners = (world: World) => world.spawns.filter(spawn => spawn.argv.some(arg => arg.endsWith('listen.py')))
const flag = (world: World, index: number, name: string) => {
  const argv = listeners(world)[index]?.argv ?? []

  return argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined
}
const speaks = (world: World) => world.spawns.filter(spawn => spawn.argv.some(arg => arg.endsWith('speak.sh')))
const killedSpeech = (world: World) => world.runs.filter(argv => argv[0] === 'pkill' && argv.some(arg => arg.startsWith('speak\\.sh'))).length
const status = async ($: Engine) => (await $.command.run(live('status'))).text

// A spoken prompt, then its live turn streaming a three-sentence reply that
// keeps playing (the first sentence holds the player).
async function speakingTurn($: Engine, world: World, heard = 'hola mundo') {
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  world.hear('/run/user/1000/live-voice/utt-1.wav')
  await settle(world)
  world.playback.hold = true
  world.reply.text = 'Uno. Dos. Tres.'
  await $.turn.start({ turnId: 't1', text: heard })
  for await (const _ of $.turn.step({ turnId: 't1', ...STEP })) {
    // Drain the step.
  }
  await settle(world)
}

test('speaking over a reply cuts the voice, drops the queue, aborts the live turn and submits what was said', SLOW, async ($, on) => {
  const world = fakeWorld(on, 'para, otra cosa')
  await speakingTurn($, world, 'para, otra cosa')
  expect(speaks(world)).toHaveLength(1)
  expect(await status($)).toMatch(/: speaking.*[12] sentence\(s\) queued/)
  expect(world.files.get(PAUSED)).toBe('2')
  const killsBefore = killedSpeech(world)

  world.hear('barge')
  await settle(world)
  expect(world.aborts).toEqual(['t1'])
  expect(killedSpeech(world)).toBeGreaterThan(killsBefore)
  expect(await status($)).toMatch(/: listening, voice \S+, 0 sentence\(s\) queued/)
  expect(speaks(world)).toHaveLength(1)

  // The killed player ends (the fake's held player stands for it), the engine
  // ends the aborted turn, and the utterance follows as a live prompt; no echo
  // tail after a barge-in, the mic listens normally at once.
  world.playback.release()
  await $.turn.complete({ turnId: 't1', answer: 'Uno.', durationMs: 1, isAborted: true, reason: 'aborted' })
  await settle(world, 50)
  expect(world.files.get(PAUSED)).toBe('0')
  world.hear('/run/user/1000/live-voice/utt-2.wav')
  await settle(world)
  expect(world.prompts.map(prompt => prompt.text)).toEqual(['para, otra cosa', 'para, otra cosa'])
  expect(world.files.get(PAUSED)).toBe('0')
  await $.command.run(live('off'))
  world.playback.release()
  await settle(world)
})

test('a barge-in after the turn ended still cuts the voice but aborts nothing', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await speakingTurn($, world)
  await $.turn.complete({ turnId: 't1', answer: 'Uno. Dos. Tres.', durationMs: 1, isAborted: false, reason: 'answer' })
  await settle(world)
  world.hear('barge')
  await settle(world)
  expect(world.aborts).toEqual([])
  expect(await status($)).toMatch(/0 sentence\(s\) queued/)
  await $.command.run(live('off'))
  world.playback.release()
  await settle(world)
})

test('interrupt off pauses the mic while speaking and ignores a barge line', { ...SLOW }, async ($, on) => {
  const world = fakeWorld(on)
  world.store.set('interrupt', 'off')
  await speakingTurn($, world)
  expect(world.files.get(PAUSED)).toBe('1')
  world.hear('barge')
  await settle(world)
  expect(world.aborts).toEqual([])
  expect(await status($)).toMatch(/: speaking/)
  await $.command.run(live('off'))
  world.playback.release()
  await settle(world)
})

test('muted wins over barge-in: paused while speaking, a barge line ignored', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await speakingTurn($, world)
  await $.command.run(live('mute'))
  expect(world.files.get(PAUSED)).toBe('1')
  world.hear('barge')
  await settle(world)
  expect(world.aborts).toEqual([])
  await $.command.run(live('off'))
  world.playback.release()
  await settle(world)
})

test('a barge line while nothing is spoken aborts no turn, not even a typed one', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  await $.prompt.submit({ text: 'escrito', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ turnId: 'typed', text: 'escrito' })
  world.hear('barge')
  await settle(world)
  expect(world.aborts).toEqual([])
  await $.command.run(live('off'))
})

test('the listener gets the barge-in flags: speakers stricter, headphones the normal start', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  expect(flag(world, 0, '--barge-ratio')).toBe('6')
  expect(flag(world, 0, '--barge-frames')).toBe('14')

  expect((await $.command.run(live('config interrupt headphones'))).text).toBe('Interrupt set to headphones.')
  await settle(world)
  expect(world.store.get('interrupt')).toBe('headphones')
  expect(listeners(world)).toHaveLength(2)
  expect(flag(world, 1, '--barge-ratio')).toBe('3')
  expect(flag(world, 1, '--barge-frames')).toBe('3')
  expect((await $.command.run(live('config interrupt bogus'))).text).toMatch(/interrupt <off\|headphones\|speakers>/)
  await $.command.run(live('off'))
})

test('headphones listen for barge-in while speaking too', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.store.set('interrupt', 'headphones')
  await speakingTurn($, world)
  expect(world.files.get(PAUSED)).toBe('2')
  world.hear('barge')
  await settle(world)
  expect(world.aborts).toEqual(['t1'])
  await $.command.run(live('off'))
  world.playback.release()
  await settle(world)
})

test('the dialog and the summary show the interrupt setting; reset restores speakers', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.panes.isPlaced = false
  await $.session.start(START)
  expect((await $.command.run(live('config'))).text).toMatch(/interrupt\s+speakers/)
  await $.command.run(live('config'))
  const pane = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...PANE })
  const select = await pane.find({ key: 'interrupt' })
  expect((select?.props.options as { value: string }[]).map(option => option.value)).toEqual(['off', 'headphones', 'speakers'])
  expect(select?.props.value).toBe('speakers')
  await pane.select({ key: 'interrupt', value: 'off' })
  await settle(world)
  expect(world.store.get('interrupt')).toBe('off')
  await pane.unmount()
  await $.command.run(live('config reset'))
  expect(world.store.has('interrupt')).toBe(false)
  expect((await $.command.run(live('config'))).text).toMatch(/interrupt\s+speakers/)
})
