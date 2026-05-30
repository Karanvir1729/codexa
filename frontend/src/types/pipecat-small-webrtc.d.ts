declare module "@pipecat-ai/small-webrtc-transport" {
  export interface SmallWebRTCTransportConstructorOptions {
    connectionUrl?: string;
    webrtcUrl?: string;
    webrtcRequestParams?: unknown;
    iceConfig?: {
      iceServers?: RTCIceServer[];
    };
    iceServers?: RTCIceServer[];
    waitForICEGathering?: boolean;
    audioCodec?: string;
    videoCodec?: string;
    mediaManager?: unknown;
    offerUrlTemplate?: string;
  }

  export class SmallWebRTCTransport {
    constructor(options?: SmallWebRTCTransportConstructorOptions);
  }

  export class WavMediaManager {
    constructor(recorderChunkSize?: number, recorderSampleRate?: number);
  }
}
