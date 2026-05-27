// EXPERIMENTAL embedded libmpv canvas player (Stage E1).
//
// Pull model (A1): a requestAnimationFrame loop calls window.embeddedMpv.getFrame()
// and draws new RGBA frames into a <canvas> via putImageData. This is a
// copy-based, unoptimized experiment — it does NOT replace the external MPV
// player, which remains the default/fallback everywhere else.
//
// If the native addon is missing or fails, this page shows a friendly error and
// the rest of the app is unaffected.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildPlayRequest,
  dispatchPlayRequest,
} from "../features/player/playRequest.js";

const DEFAULT_URL =
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4";

interface Stats {
  fps: number;
  avgGetMs: number;
  drawn: number;
  skipped: number;
  lastError: string | null;
}

export default function ExperimentalEmbeddedPlayerPage() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>("Idle.");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats>({
    fps: 0,
    avgGetMs: 0,
    drawn: 0,
    skipped: 0,
    lastError: null,
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const lastIndexRef = useRef(0);

  // Rolling counters for the stats overlay.
  const counters = useRef({
    drawn: 0,
    skipped: 0,
    getMsSum: 0,
    getCalls: 0,
    windowStart: 0,
    windowDrawn: 0,
  });

  const available = typeof window !== "undefined" && !!window.embeddedMpv;

  const drawFrame = useCallback(
    (width: number, height: number, rgba: Uint8Array) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // ImageData needs a Uint8ClampedArray of exactly width*height*4, backed by
      // a plain ArrayBuffer — so copy into a freshly-allocated clamped array.
      const expected = width * height * 4;
      if (rgba.length < expected) return;
      const clamped = new Uint8ClampedArray(expected);
      clamped.set(rgba.subarray(0, expected));
      const imageData = new ImageData(clamped, width, height);
      ctx.putImageData(imageData, 0, 0);
    },
    [],
  );

  const loop = useCallback(async () => {
    if (!runningRef.current) return;
    const api = window.embeddedMpv;
    if (!api) return;

    const t0 = performance.now();
    let frame: Awaited<ReturnType<NonNullable<Window["embeddedMpv"]>["getFrame"]>>;
    try {
      frame = await api.getFrame(lastIndexRef.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      stop();
      return;
    }
    const getMs = performance.now() - t0;

    const c = counters.current;
    c.getMsSum += getMs;
    c.getCalls += 1;

    if (frame.error) {
      setError(frame.error);
      stop();
      return;
    }

    if (!frame.noNewFrame && frame.rgba) {
      drawFrame(frame.width, frame.height, frame.rgba as Uint8Array);
      lastIndexRef.current = frame.frameIndex;
      c.drawn += 1;
      c.windowDrawn += 1;
    } else {
      c.skipped += 1;
    }

    // Update the stats ~4x/second.
    const now = performance.now();
    if (c.windowStart === 0) c.windowStart = now;
    const elapsed = now - c.windowStart;
    if (elapsed >= 250) {
      const fps = (c.windowDrawn * 1000) / elapsed;
      setStats({
        fps,
        avgGetMs: c.getCalls > 0 ? c.getMsSum / c.getCalls : 0,
        drawn: c.drawn,
        skipped: c.skipped,
        lastError: null,
      });
      c.windowStart = now;
      c.windowDrawn = 0;
      c.getMsSum = 0;
      c.getCalls = 0;
    }

    rafRef.current = requestAnimationFrame(() => void loop());
  }, [drawFrame]);

  const start = useCallback(async () => {
    setError(null);
    setStatus("Starting…");
    // Build an explicit PlayRequest for the embedded backend. This page has no
    // real media context, so identity fields are synthetic — dispatch only uses
    // streamUrl for the embedded backend. This goes through the SAME boundary as
    // normal playback but targets a DIFFERENT backend, so it can never touch the
    // normal (external-MPV) selection.
    const req = buildPlayRequest(
      {
        backend: "embedded-mpv-experimental",
        type: "movie",
        mediaId: "experimental",
        playableId: "experimental",
        mediaTitle: "(experimental URL)",
        streamUrl: url.trim(),
      },
      "experimental-page",
    );
    const res = await dispatchPlayRequest(req, { origin: "experimental-page" });
    if (!res.ok) {
      setError(res.error ?? "Failed to start embedded player.");
      setStatus("Failed to start.");
      return;
    }
    lastIndexRef.current = 0;
    counters.current = {
      drawn: 0,
      skipped: 0,
      getMsSum: 0,
      getCalls: 0,
      windowStart: 0,
      windowDrawn: 0,
    };
    runningRef.current = true;
    setRunning(true);
    setStatus("Playing (experimental).");
    rafRef.current = requestAnimationFrame(() => void loop());
  }, [url, loop]);

  // Defined as a stable function so loop()/unmount can call it.
  function stop() {
    runningRef.current = false;
    setRunning(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const api = window.embeddedMpv;
    if (api) void api.stop().catch(() => {});
    setStatus("Stopped.");
  }

  // Stop on unmount.
  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      const api = window.embeddedMpv;
      if (api) void api.stop().catch(() => {});
    };
  }, []);

  return (
    <div className="page">
      <h1>
        Embedded player <span className="exp-badge">EXPERIMENTAL</span>
      </h1>
      <div className="warning-banner" role="note">
        This is an experimental libmpv canvas renderer. It is <strong>copy-based
        and unoptimized</strong> (each frame is copied native → main → renderer),
        so it may be choppy at higher resolutions. It does <strong>not</strong>{" "}
        replace the external MPV player. Requires the native addon in{" "}
        <code>native/embedded-mpv</code> to be built.
      </div>

      {!available && (
        <div className="error-banner" role="alert">
          The embedded player bridge isn't available in this build
          (<code>window.embeddedMpv</code> missing). Rebuild the app.
        </div>
      )}

      <div className="form-row" style={{ marginTop: 12 }}>
        <input
          type="text"
          className="text-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Direct http(s) video URL"
          spellCheck={false}
          autoComplete="off"
          disabled={running}
          style={{ flex: 1 }}
        />
        {!running ? (
          <button
            type="button"
            className="primary-button"
            onClick={() => void start()}
            disabled={!available || url.trim().length === 0}
          >
            ▶ Start
          </button>
        ) : (
          <button type="button" className="ghost-button" onClick={() => stop()}>
            ⏹ Stop
          </button>
        )}
      </div>

      {error && (
        <div className="error-banner" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      <div className="embedded-stage">
        <canvas ref={canvasRef} className="embedded-canvas" />
      </div>

      <div className="embedded-stats muted small">
        <span>Status: {status}</span>
        <span>· {stats.fps.toFixed(1)} fps drawn</span>
        <span>· getFrame {stats.avgGetMs.toFixed(1)} ms avg</span>
        <span>· {stats.drawn} drawn</span>
        <span>· {stats.skipped} no-new-frame</span>
      </div>
    </div>
  );
}
