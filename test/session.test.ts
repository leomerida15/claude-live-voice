import { expect, test } from 'claude-code/testing'

import { RUNTIME_DIR, SESSION_ID, fakeWorld, settle } from './fake.ts'

const live = (args: string) => ({
  command: 'live',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 100 },
})

const SLOW = { timeoutMs: 30_000 }
const TAG = `live-voice-${SESSION_ID}`
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

test('children carry the session tag and live in a per-session directory', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  const dir = `${RUNTIME_DIR}/live-voice/${SESSION_ID}`
  const listener = world.spawns.find(spawn => spawn.argv.some(arg => arg.endsWith('listen.py')))
  expect(listener?.argv).toEqual(expect.arrayContaining(['--tag', TAG, '--dir', dir, '--pause-file', `${dir}/paused`]))
  expect(world.files.get(`${dir}/paused`)).toBe('0')
  await $.command.run(live('off'))
})

test('stopping kills only this session\'s children', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start(START)
  await $.command.run(live('on'))
  await settle(world)
  await $.command.run(live('off'))
  await settle(world)
  const kills = world.runs.filter(argv => argv[0] === 'pkill')
  expect(kills.length).toBeGreaterThan(0)
  for (const argv of kills) {
    const pattern = argv[argv.length - 1] ?? ''
    expect(pattern).toContain(TAG)
    expect(pattern).not.toMatch(/^\/.*\.(py|sh)$/)
    expect(argv).toContain('--')
  }
})
