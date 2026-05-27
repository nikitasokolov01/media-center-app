// Ambient typing for the EXPERIMENTAL embedded libmpv bridge exposed by
// electron/preload.ts (`window.embeddedMpv`). Kept in its own file so it does
// not touch the existing (hand-edited) electronAPI/mediaCenter declarations.

export {};

export interface EmbeddedStartResult {
  ok: boolean;
  error?: string;
}

export interface EmbeddedFrame {
  ok: boolean;
  error?: string;
  noNewFrame: boolean;
  width: number;
  height: number;
  frameIndex: number;
  /** Present only when a new frame is available (RGBA bytes, width*height*4). */
  rgba?: Uint8Array;
}

declare global {
  interface Window {
    embeddedMpv?: {
      start: (url: string) => Promise<EmbeddedStartResult>;
      stop: () => Promise<EmbeddedStartResult>;
      getFrame: (sinceIndex: number) => Promise<EmbeddedFrame>;
    };
  }
}
