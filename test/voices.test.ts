import { describe, expect, test } from 'claude-code/testing'

import {
  MAX_SELECT_OPTIONS,
  describeVoice,
  groupVoices,
  parseLiveCommand,
  sampleText,
  selectOptions,
  voiceChoice,
  voiceLabel,
  voiceOption,
  voicePicker,
} from '../hooks/text.ts'

describe('Kokoro voices', () => {
  test('describeVoice reads the native language, the gender and the name from the id', () => {
    expect(describeVoice('ef_dora')).toEqual({ id: 'ef_dora', name: 'Dora', language: 'Spanish', gender: 'female' })
    expect(describeVoice('am_adam')).toEqual({ id: 'am_adam', name: 'Adam', language: 'American English', gender: 'male' })
    expect(describeVoice('bf_emma').language).toBe('British English')
    expect(describeVoice('ff_siwis').language).toBe('French')
    expect(describeVoice('hf_alpha').language).toBe('Hindi')
    expect(describeVoice('if_sara').language).toBe('Italian')
    expect(describeVoice('jf_alpha').language).toBe('Japanese')
    expect(describeVoice('pm_alex').language).toBe('Brazilian Portuguese')
    expect(describeVoice('zf_xiaobei').language).toBe('Mandarin Chinese')
  })

  test('describeVoice drops a v0 prefix from the name', () => {
    expect(describeVoice('af_v0bella')).toMatchObject({ name: 'Bella', language: 'American English', gender: 'female' })
  })

  test('describeVoice calls an unknown language Other', () => {
    expect(describeVoice('xm_bob')).toMatchObject({ name: 'Bob', language: 'Other', gender: 'male' })
    expect(describeVoice('qq_odd')).toMatchObject({ language: 'Other', gender: 'unknown' })
  })

  test('voiceLabel and voiceOption describe a voice for the dialog', () => {
    expect(voiceLabel('ef_dora')).toBe('Dora · Spanish · female (ef_dora)')
    expect(voiceOption('ef_dora')).toBe('Spanish — Dora (female)')
  })

  test('groupVoices puts the Spanish session language first, the rest alphabetically, names sorted', () => {
    const groups = groupVoices(['bm_george', 'af_heart', 'em_santa', 'ef_dora', 'em_alex', 'ff_siwis', 'xm_bob'], 'es')
    expect(groups.map(group => group.language)).toEqual(['Spanish', 'American English', 'British English', 'French', 'Other'])
    expect(groups[0]?.voices.map(voice => voice.id)).toEqual(['em_alex', 'ef_dora', 'em_santa'])
  })

  test('groupVoices with English first puts American then British English first', () => {
    const groups = groupVoices(['ef_dora', 'bf_emma', 'am_adam', 'af_heart', 'ff_siwis'], 'en')
    expect(groups.map(group => group.language)).toEqual(['American English', 'British English', 'French', 'Spanish'])
    expect(groups[0]?.voices.map(voice => voice.id)).toEqual(['am_adam', 'af_heart'])
  })

  test('groupVoices keeps each voice once and an unknown session language sorts every group', () => {
    const groups = groupVoices(['ef_dora', 'ef_dora', 'af_heart'], 'xx')
    expect(groups.map(group => group.language)).toEqual(['American English', 'Spanish'])
    expect(groups[1]?.voices).toHaveLength(1)
  })

  test('sampleText speaks the voice\'s own language: Spanish, English, else English', () => {
    expect(sampleText('ef_dora')).toBe('Hola, así suena esta voz.')
    expect(sampleText('af_heart')).toBe('Hi, this is how this voice sounds.')
    expect(sampleText('bm_george')).toBe('Hi, this is how this voice sounds.')
    expect(sampleText('ff_siwis')).toBe('Hi, this is how this voice sounds.')
  })

  test('selectOptions caps a list at the 64 options a Select takes, order kept', () => {
    expect(MAX_SELECT_OPTIONS).toBe(64)
    const many = Array.from({ length: 70 }, (_, at) => `af_v${String(at).padStart(2, '0')}`)
    expect(selectOptions(many)).toEqual(many.slice(0, 64))
    expect(selectOptions(['ef_dora'])).toEqual(['ef_dora'])
  })

  test('voiceChoice names a voice under its language: Dora (female)', () => {
    expect(voiceChoice('ef_dora')).toBe('Dora (female)')
    expect(voiceChoice('am_v0adam')).toBe('Adam (male)')
  })

  test('voicePicker shows the voice\'s own language by default, a wanted one when listed', () => {
    const ids = ['af_heart', 'bm_george', 'em_alex', 'ef_dora']
    const own = voicePicker(ids, 'ef_dora', 'es')
    expect(own.languages).toEqual(['Spanish', 'American English', 'British English'])
    expect(own.language).toBe('Spanish')
    expect(own.voices.map(voice => voice.id)).toEqual(['em_alex', 'ef_dora'])
    expect(voicePicker(ids, 'ef_dora', 'es', 'British English').voices.map(voice => voice.id)).toEqual(['bm_george'])
    expect(voicePicker(ids, 'ef_dora', 'es', 'Klingon').language).toBe('Spanish')
  })

  test('voicePicker lists a voice Kokoro did not, and caps a language at 64 voices', () => {
    expect(voicePicker(['af_heart'], 'ff_siwis', 'es').languages).toEqual(['American English', 'French'])
    const many = Array.from({ length: 70 }, (_, at) => `af_v${String(at).padStart(2, '0')}`)
    const picker = voicePicker(many, 'af_v00', 'en')
    expect(picker.voices).toHaveLength(64)
    expect(picker.voices[0]?.id).toBe('af_v00')
  })

  test('/live config test parses', () => {
    expect(parseLiveCommand('config test')).toEqual({ kind: 'config-test' })
    expect(parseLiveCommand('config test now').kind).toBe('error')
  })
})
