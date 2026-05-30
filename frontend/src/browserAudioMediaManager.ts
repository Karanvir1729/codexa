import type { TransportState } from "@pipecat-ai/client-js";

type PipecatClientOptions = {
  callbacks?: {
    onAvailableMicsUpdated?: (devices: MediaDeviceInfo[]) => void;
    onAvailableCamsUpdated?: (devices: MediaDeviceInfo[]) => void;
    onAvailableSpeakersUpdated?: (devices: MediaDeviceInfo[]) => void;
    onMicUpdated?: (device: unknown) => void;
    onTrackStarted?: (track: MediaStreamTrack, participant?: unknown) => void;
    onTrackStopped?: (track: MediaStreamTrack, participant?: unknown) => void;
    onTransportStateChanged?: (state: TransportState) => void;
  };
  enableMic?: boolean;
  enableCam?: boolean;
};

const localParticipant = { local: true, name: "browser" };

export function audioPlayErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") {
    return null;
  }
  return error instanceof Error ? error.message : "Audio playback failed.";
}

export async function playAudioTrack(audio: HTMLAudioElement, track: MediaStreamTrack) {
  const currentStream = audio.srcObject instanceof MediaStream ? audio.srcObject : null;
  const currentTrack = currentStream?.getAudioTracks()[0] ?? null;
  if (currentTrack !== track) {
    audio.srcObject = new MediaStream([track]);
  }
  audio.muted = false;
  audio.volume = 1;
  await audio.play();
}

export function clearAudioElement(audio: HTMLAudioElement) {
  audio.pause();
  audio.srcObject = null;
}

export class BrowserAudioMediaManager {
  private options: PipecatClientOptions = {};
  private micEnabled = false;
  private camEnabled = false;
  private audioContext: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private silence: OscillatorNode | null = null;
  private silenceGain: GainNode | null = null;
  private micStream: MediaStream | null = null;
  private pendingMicStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAttachPromise: Promise<void> | null = null;
  private selectedMicDeviceId = "";

  setClientOptions(options: PipecatClientOptions, override = false) {
    if (this.options.callbacks && !override) return;
    this.options = options;
    this.micEnabled = this.micEnabled || (options.enableMic ?? false);
    this.camEnabled = options.enableCam ?? false;
  }

  async initialize() {
    if (this.destination) return;

    this.audioContext = new AudioContext({ sampleRate: 48000 });
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    this.destination = this.audioContext.createMediaStreamDestination();
    this.silence = this.audioContext.createOscillator();
    this.silenceGain = this.audioContext.createGain();
    this.silenceGain.gain.value = 0;
    this.silence.connect(this.silenceGain);
    this.silenceGain.connect(this.destination);
    this.silence.start();

    this.options.callbacks?.onAvailableCamsUpdated?.([]);
    this.options.callbacks?.onAvailableSpeakersUpdated?.([]);
    this.options.callbacks?.onAvailableMicsUpdated?.(await this.getAllMics());
  }

  async connect() {
    await this.initialize();
    if (this.micEnabled) {
      await this.ensureMicAttached();
    }
  }

  async disconnect() {
    this.stopMic();
    this.silence?.stop();
    this.silence?.disconnect();
    this.silenceGain?.disconnect();
    await this.audioContext?.close();
    this.audioContext = null;
    this.destination = null;
    this.silence = null;
    this.silenceGain = null;
    this.micAttachPromise = null;
    this.micEnabled = false;
  }

  async userStartedSpeaking() {
    return undefined;
  }

  bufferBotAudio(data: ArrayBuffer | Int16Array) {
    return data instanceof Int16Array ? data : new Int16Array(data);
  }

  async getAllMics() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput");
  }

  async getAllCams() {
    return [];
  }

  async getAllSpeakers() {
    return [];
  }

  updateMic(micId: string) {
    this.selectedMicDeviceId = micId;
    if (this.micEnabled) {
      void this.ensureMicAttached();
    }
  }

  updateCam() {
    this.camEnabled = false;
  }

  updateSpeaker() {
    return undefined;
  }

  setPendingMicStream(stream: MediaStream) {
    this.pendingMicStream?.getTracks().forEach((track) => track.stop());
    this.pendingMicStream = stream;
  }

  get selectedMic() {
    return this.selectedMicDeviceId ? { deviceId: this.selectedMicDeviceId } : {};
  }

  get selectedCam() {
    return {};
  }

  get selectedSpeaker() {
    return {};
  }

  private microphoneConstraints(): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 }
    };
    if (this.selectedMicDeviceId) {
      constraints.deviceId = { exact: this.selectedMicDeviceId };
    }
    return constraints;
  }

  enableMic(enable: boolean) {
    this.micEnabled = enable;
    if (enable) {
      void this.ensureMicAttached();
    } else {
      this.stopMic();
    }
  }

  enableCam(enable: boolean) {
    this.camEnabled = enable;
  }

  enableScreenShare() {
    return undefined;
  }

  get isCamEnabled() {
    return this.camEnabled;
  }

  get isMicEnabled() {
    return this.micEnabled;
  }

  get isSharingScreen() {
    return false;
  }

  get supportsScreenShare() {
    return false;
  }

  tracks() {
    return {
      local: {
        audio: this.destination?.stream.getAudioTracks()[0]
      }
    };
  }

  private ensureMicAttached() {
    if (this.micSource && !this.pendingMicStream) return Promise.resolve();
    if (!this.micAttachPromise) {
      this.micAttachPromise = this.attachMic().finally(() => {
        this.micAttachPromise = null;
      });
    }
    return this.micAttachPromise;
  }

  private async attachMic() {
    await this.initialize();
    if (this.audioContext?.state === "suspended") {
      await this.audioContext.resume();
    }
    this.stopMic();

    if (this.pendingMicStream) {
      this.micStream = this.pendingMicStream;
      this.pendingMicStream = null;
    } else {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: this.microphoneConstraints(),
        video: false
      });
    }
    const [inputTrack] = this.micStream.getAudioTracks();
    this.selectedMicDeviceId = inputTrack?.getSettings().deviceId ?? this.selectedMicDeviceId;
    if (!this.audioContext || !this.destination) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
      return;
    }

    this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
    this.micSource.connect(this.destination);

    const outputTrack = this.destination.stream.getAudioTracks()[0];
    this.options.callbacks?.onMicUpdated?.(this.selectedMic);
    if (outputTrack) {
      this.options.callbacks?.onTrackStarted?.(outputTrack, localParticipant);
    }
  }

  private stopMic() {
    const outputTrack = this.destination?.stream.getAudioTracks()[0];
    this.micSource?.disconnect();
    this.micSource = null;
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;
    if (outputTrack) {
      this.options.callbacks?.onTrackStopped?.(outputTrack, localParticipant);
    }
  }
}
