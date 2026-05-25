declare module "@pipecat-ai/client-js" {
  export type TransportState =
    | "disconnected"
    | "initializing"
    | "initialized"
    | "authenticating"
    | "authenticated"
    | "connecting"
    | "connected"
    | "ready"
    | "disconnecting"
    | "error";

  export class PipecatClient {
    constructor(options: any);
    connect(connectParams?: unknown): Promise<unknown>;
    disconnect(): Promise<void>;
    enableMic(enable: boolean): void;
    get isMicEnabled(): boolean;
  }
}
