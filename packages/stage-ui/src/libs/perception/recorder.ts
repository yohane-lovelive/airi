/** One frame of a screen recording, as the runner sends it. */
export interface RecorderFrame {
  readonly at: number
  /** The JPEG bytes of the frame. */
  readonly image: Uint8Array
  /** The grayscale thumbnail as base64, so replay can run the detectors without decoding images. */
  readonly thumbnail: string
  readonly app?: string
}

/** One line of the event log of a recording: a screen event, or an owner message without its text. */
export type RecorderEvent
  = | { readonly kind: 'screen', readonly at: number, readonly type: string, readonly salience: number, readonly app?: string }
    | { readonly kind: 'owner-message', readonly at: number }

/** One recording on the device. */
export interface RecordingInfo {
  readonly id: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly frames: number
  readonly bytes: number
  readonly recording: boolean
}

/**
 * Where the screen recorder writes. Only the desktop app has one, because a browser cannot write a folder.
 * Recordings stay on the device.
 */
export interface PerceptionRecorderSink {
  start: () => Promise<RecordingInfo>
  /** Resolves to the reason when the recording stopped at a limit, or when it does not run. */
  appendFrame: (id: string, frame: RecorderFrame) => Promise<{ stopped?: 'time' | 'size' | 'not-recording' }>
  appendEvents: (id: string, events: RecorderEvent[]) => Promise<void>
  stop: () => Promise<RecordingInfo | undefined>
  list: () => Promise<RecordingInfo[]>
  remove: (id: string) => Promise<boolean>
  openFolder: () => Promise<void>
}
