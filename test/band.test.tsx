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
