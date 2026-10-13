export type LiveVoiceState = 'off' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'muted'

export type LiveVoiceStatus = {
  isOn: boolean
  state: LiveVoiceState
  queue: number
  voice: string
}

declare module 'claude-code' {
  interface PluginState {
    'live-voice': { status: LiveVoiceStatus }
  }
}
