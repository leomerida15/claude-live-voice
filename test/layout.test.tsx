import { expect, test } from 'claude-code/testing'

import { cellWidth, channelBarWidth, packRows, selectWidth } from '../hooks/text.ts'
import { fakeWorld } from './fake.ts'

// The 67 voices a real Kokoro lists: the longest language and voice labels.
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
const config = (args: string) => ({
  command: 'live',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: true, columns: 189 },
})
const docked = (bodyColumns: number) => ({
  component: 'Pane',
  requestId: 'live-voice-config',
  props: {
    title: 'Live voice settings',
    isFocused: true,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
}) as const

type Node = string | { type: string; props?: Record<string, unknown>; children?: Node[] }
type Option = { value: string; label?: string }

const kids = (node: Node) => (typeof node === 'string' ? [] : (node.children ?? []))
const propsOf = (node: Node): Record<string, unknown> => (typeof node === 'string' ? {} : (node.props ?? {}))
const isTruncated = (node: Node) => String(propsOf(node).wrap ?? '').startsWith('truncate')

// The cells a node takes on its row, erring wide: a Select draws its label, a
// space, its longest option and the painter's `▾` marks; a Button its hotkey
// (`q: `) and its label; a truncating Text gives way to the room it gets.
function widthOf(node: Node): number {
  if (typeof node === 'string') return cellWidth(node)
  const children = kids(node)
  const props = propsOf(node)
  switch (node.type) {
    case 'Text':
      return isTruncated(node) ? 1 : children.reduce<number>((sum, child) => sum + widthOf(child), 0)
    case 'Button': {
      const hotkey = typeof props.hotkey === 'string' ? cellWidth(props.hotkey) + 2 : 0
      const label = typeof props.label === 'string' ? cellWidth(props.label) : children.reduce<number>((sum, child) => sum + widthOf(child), 0)

      return hotkey + label
    }
    case 'Select': {
      const label = typeof props.label === 'string' ? cellWidth(props.label) + 1 : 0
      const options = (props.options ?? []) as Option[]

      return label + Math.max(...options.map(option => cellWidth(option.label ?? option.value))) + 2
    }
    case 'Box': {
      const gap = typeof props.gap === 'number' ? props.gap : 0
      const widths = children.map(widthOf)
      if (props.flexDirection === 'row') return widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1)

      return Math.max(0, ...widths)
    }
    default:
      return children.reduce<number>((sum, child) => Math.max(sum, widthOf(child)), 0)
  }
}

// Every row Box (outermost first) and the widest of them.
function rows(node: Node, found: Node[] = []): Node[] {
  if (typeof node === 'string') return found
  if (node.type === 'Box' && propsOf(node).flexDirection === 'row') found.push(node)
  for (const child of kids(node)) rows(child, found)

  return found
}
const holds = (node: Node, key: string): boolean =>
  typeof node !== 'string' && (propsOf(node).key === key || kids(node).some(child => holds(child, key)))
const textsOf = (node: Node): string[] =>
  typeof node === 'string' ? [] : node.type === 'Text' ? [kids(node).filter(child => typeof child === 'string').join('')] : kids(node).flatMap(textsOf)

test('the settings dock opens 100 columns wide and fits every row at 50 and 100 columns', SLOW, async ($, on) => {
  const world = fakeWorld(on)
  world.voices.list = [...KOKORO_VOICES]
  await $.session.start(START)
  await $.command.run(config('config'))
  expect(world.openings.at(-1)).toMatchObject({ id: 'live-voice-config', columns: 100, focus: true, closeOnEscape: true, holdToasts: true })
  expect(typeof world.openings.at(-1)?.rows).toBe('number')

  for (const columns of [50, 100]) {
    const pane = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...docked(columns) })
    const tree = (await pane.drawn()) as Node
    for (const row of rows(tree)) expect(widthOf(row)).toBeLessThanOrEqual(columns)
    expect(widthOf(tree)).toBeLessThanOrEqual(columns)

    // One row per channel holds its − and + buttons, its bar and its padded value.
    for (const channel of ['red', 'green', 'blue']) {
      const row = rows(tree).filter(one => holds(one, `${channel}-down`)).at(-1)
      expect(row).toBeDefined()
      if (row === undefined) continue
      expect(holds(row, `${channel}-up`)).toBe(true)
      const texts = textsOf(row)
      const bar = texts.find(text => /^[█░]+$/.test(text)) ?? ''
      expect(cellWidth(bar)).toBeGreaterThanOrEqual(6)
      expect(texts.some(text => /^[ \d]{3}$/.test(text) && /\d$/.test(text))).toBe(true)
    }
    await pane.unmount()
  }

  // Wide enough, the language, the voice and the test share one row.
  const wide = await $.ui.mount({ plugin: 'live-voice', surface: 'terminal', ...docked(100) })
  const tree = (await wide.drawn()) as Node
  const voiceRow = rows(tree).find(one => holds(one, 'voice-language'))
  expect(voiceRow !== undefined && holds(voiceRow, 'voice') && holds(voiceRow, 'test-voice')).toBe(true)
  await wide.unmount()
})

test('packRows fills rows in order within the room; channelBarWidth and selectWidth size the fields', () => {
  expect(packRows([10, 10, 10, 10], 34, 2)).toEqual([[0, 1, 2], [3]])
  expect(packRows([10, 10, 10, 10], 22, 2)).toEqual([[0, 1], [2, 3]])
  expect(packRows([40, 5], 30, 2)).toEqual([[0], [1]])
  expect(packRows([], 30, 2)).toEqual([])
  expect(channelBarWidth(48)).toBe(32)
  expect(channelBarWidth(10)).toBe(6)
  expect(channelBarWidth(200)).toBe(48)
  expect(selectWidth('Voice', [{ value: 'ef_dora', label: 'Dora (female)' }, { value: 'x' }])).toBe(6 + 13 + 2)
  expect(selectWidth('', [{ value: 'suggestion' }])).toBe(12)
})
