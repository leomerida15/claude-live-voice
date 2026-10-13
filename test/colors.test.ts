import { describe, expect, test } from 'claude-code/testing'

import {
  CONFIG_USAGE,
  THEME_COLORS,
  channelBar,
  customBase,
  hexToRgb,
  liveColors,
  parseColor,
  parseLiveCommand,
  rgbToHex,
  stepChannel,
} from '../hooks/text.ts'

describe('colors', () => {
  test('parseColor takes theme keys (any case, kept as the theme spells them), names and hex', () => {
    expect(parseColor('claude')).toBe('claude')
    expect(parseColor('planmode')).toBe('planMode')
    expect(parseColor('PLANMODE')).toBe('planMode')
    expect(parseColor('Red')).toBe('red')
    expect(parseColor('#FF8800')).toBe('#ff8800')
    expect(parseColor('#f80')).toBe('#ff8800')
  })

  test('parseColor refuses anything else', () => {
    for (const bad of ['pink', '', '#ff88', '#gg0000', 'ff8800', '#ff88001', 'text', 'diffAdded', undefined, 3]) {
      expect(parseColor(bad)).toBeUndefined()
    }
  })

  test('the theme colors offered are the ones the band suits', () => {
    expect(THEME_COLORS).toEqual(['claude', 'success', 'suggestion', 'warning', 'error', 'permission', 'planMode', 'ide', 'remember', 'inactive', 'subtle'])
  })

  test('hexToRgb and rgbToHex convert both ways', () => {
    expect(hexToRgb('#ff8800')).toEqual([255, 136, 0])
    expect(hexToRgb('#0a0B0c')).toEqual([10, 11, 12])
    expect(hexToRgb('red')).toBeUndefined()
    expect(rgbToHex([255, 136, 0])).toBe('#ff8800')
    expect(rgbToHex([300, -4, 7.6])).toBe('#ff0008')
  })

  test('stepChannel moves a channel by the step, clamped to 0..255', () => {
    expect(stepChannel(128, 16)).toBe(144)
    expect(stepChannel(250, 16)).toBe(255)
    expect(stepChannel(5, -16)).toBe(0)
    expect(stepChannel(0, 1)).toBe(1)
  })

  test('channelBar fills its cells in proportion to the value', () => {
    expect(channelBar(0, 20)).toBe('░'.repeat(20))
    expect(channelBar(255, 20)).toBe('█'.repeat(20))
    expect(channelBar(128, 20)).toBe(`${'█'.repeat(10)}${'░'.repeat(10)}`)
    expect(channelBar(999, 4)).toBe('████')
  })

  test('customBase is where the RGB bars start: the hex itself, a name\'s RGB, or mid gray for a theme key', () => {
    expect(customBase('#123456')).toBe('#123456')
    expect(customBase('red')).toBe('#ff0000')
    expect(customBase('claude')).toBe('#808080')
  })

  test('liveColors keeps theme keys and hex from the store', () => {
    expect(liveColors({ user: 'claude', agent: '#ff8800', dot: 'pink', idle: '#FFF' })).toEqual({
      user: 'claude',
      agent: '#ff8800',
      dot: 'red',
      idle: '#ffffff',
    })
  })

  test('/live config <target> takes a theme key, a name or hex; the usage lists the kinds', () => {
    expect(parseLiveCommand('config agent planMode')).toEqual({ kind: 'config-set', target: 'agent', color: 'planMode' })
    expect(parseLiveCommand('config user #ABC')).toEqual({ kind: 'config-set', target: 'user', color: '#aabbcc' })
    expect(parseLiveCommand('config dot magenta')).toEqual({ kind: 'config-set', target: 'dot', color: 'magenta' })
    expect(parseLiveCommand('config user pink')).toEqual({ kind: 'error', message: CONFIG_USAGE })
    expect(CONFIG_USAGE).toContain('#rrggbb')
    expect(CONFIG_USAGE).toContain('claude|success')
  })
})
