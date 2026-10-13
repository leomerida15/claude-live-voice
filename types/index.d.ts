export type LiveVoiceState = 'off' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'muted'

export type LiveVoiceStatus = {
  isOn: boolean
  state: LiveVoiceState
  queue: number
  voice: string
  /**
   * The mic levels (0..1) heard while listening, newest last, at most
   * METER_CAP (200) of them; [] in any other state. The band draws the newest
   * as many as it is wide.
   */
  levels: number[]
  /** The speaking wave's frame: it moves 8 times a second while speaking. */
  wave: number
  /** Whether the audio bar's live dot is lit: it blinks every 500 ms while on and not muted. */
  dot: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'live-voice': { status: LiveVoiceStatus }
  }
}
