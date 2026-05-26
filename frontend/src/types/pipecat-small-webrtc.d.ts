declare module "@pipecat-ai/small-webrtc-transport" {
  export class SmallWebRTCTransport {
    constructor(options?: unknown);
  }

  export class WavMediaManager {
    constructor(recorderChunkSize?: number, recorderSampleRate?: number);
  }
}
