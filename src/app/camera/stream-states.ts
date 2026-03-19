export const LIVE_STATES = ['idle', 'starting', 'streaming', 'stopping'] as const
export const PLAYBACK_STATES = ['idle', 'loading-recordings', 'starting', 'playing', 'stopping'] as const

export type LiveState = typeof LIVE_STATES[number]
export type PlaybackState = typeof PLAYBACK_STATES[number]
