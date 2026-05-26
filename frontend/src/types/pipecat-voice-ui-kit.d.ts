declare module "@pipecat-ai/voice-ui-kit" {
  import type { ReactNode } from "react";

  export function Badge(props: {
    children?: ReactNode;
    color?: string;
    rounded?: string;
    variant?: string;
    [key: string]: unknown;
  }): JSX.Element;

  export function CircularWaveform(props: {
    audioTrack?: MediaStreamTrack | null;
    backgroundColor?: string;
    barWidth?: number;
    color1?: string;
    color2?: string;
    isThinking?: boolean;
    numBars?: number;
    rotationEnabled?: boolean;
    sensitivity?: number;
    size?: number;
    [key: string]: unknown;
  }): JSX.Element;

  export function ThemeProvider(props: {
    children?: ReactNode;
    [key: string]: unknown;
  }): JSX.Element;
}

declare module "@pipecat-ai/voice-ui-kit/styles" {
  const styles: string;
  export default styles;
}
