export type LiveVoiceState = 'off' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'muted'

export type LiveVoiceStatus = {
  isOn: boolean
  state: LiveVoiceState
  queue: number
  voice: string
  /** What the band's meter shows: the mic level sparkline while listening, the wave while speaking, else ''. */
  meter: string
}

declare module 'claude-code' {
  interface PluginState {
    'live-voice': { status: LiveVoiceStatus }
  }
}
