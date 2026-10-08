/**
 * Share timelapse (DESIGN §8 Export): the drawing replays stroke by stroke, each Form growing as it
 * does in Replay, into a short video ready to post.
 *
 *  - Render path. The live view is a stack of CSS-blended canvases, so the screen cannot be
 *    recorded. The timelapse builds its own private live layer (render/live.ts createLiveLayer) over
 *    two offscreen canvases at video size and plays every stroke through it exactly as Replay does
 *    (the same PlayStroke: trunk on its own timing, growth a hand's breadth behind the nib, pools
 *    rising with their halo, hot ink). Finished strokes bake into an offscreen base canvas through
 *    the tiles' drawInk, and the Night bloom of that base cures in over 400 ms as on screen. Each
 *    frame composites ground, base, bloom, #dry and #wet into ONE canvas with the canvas ops that
 *    mirror the CSS blends (opFor: lighter on Night, multiply on Paper), as the snapshot does.
 *    The app's renderer, tiles and camera are never touched, so drawing goes on while it records.
 *  - Encoding. WebCodecs where it exists (Chrome, Edge, Safari 17+, Firefox 130+): H.264 frames
 *    with exact timestamps, encoded as fast as the device allows (a few frames per rAF, yielding
 *    in between), then export/mp4.ts writes a fast-start MP4. Fallback: MediaRecorder on
 *    canvas.captureStream(0) with one requestFrame() per frame, in real time on the wall clock
 *    (MediaRecorder stamps frames itself), MP4 where supported, else WebM.
 *  - Framing. 1080 × 1080, or 1080 × 1350 (4:5) for a drawing taller than wide; the content plus
 *    a 10 % margin, centred, never magnified past 3× the zoom it was drawn at.
 *  - Duration. Gap-capped drawing time T plays at k = T / clamp(T / 1.5, 5 s, 10 s), never
 *    slower than half speed; then the last growth finishes and the piece holds for 1 s. Anything
 *    still growing at 11 s fast-forwards, so a video is at most 12 s.
 *  - A small `sketch.syberlabs.io` wordmark sits in the bottom-right corner.
 */
import type { AABB, Cooked, Ground, StrokeRecipe } from '../core/types';
import type { LiveHost } from '../render/types';
import { createLiveLayer, drawInk } from '../render/live';
import { inkTableFor, regionMatrix } from '../render/raster';
import { paintGround } from '../render/ground';
import { opFor } from '../render/compositor';
import { BLOOM_ALPHA, CURE_MS, SCALE as BLOOM_SCALE, bloomOf } from '../render/bloom';
import { muxMp4, nclx, type Mp4Sample } from './mp4';

/** Output width (px); the height is WIDTH (square) or PORTRAIT_H (4:5). */
export const WIDTH = 1080, PORTRAIT_H = 1350;
/** A drawing at least this much taller than wide gets the portrait frame. */
export const PORTRAIT_ASPECT = 1.12;
/** Margin around the content, as a fraction of its long edge. */
export const MARGIN = 0.1;
/** Never magnify a drawing past this multiple of the zoom it was drawn at. */
export const MAX_MAGNIFY = 3;
/** Playback length bounds and the preferred speed (ms, ×). */
export const PLAY_MIN_MS = 5000, PLAY_MAX_MS = 10000, PREFERRED_SPEED = 1.5, MIN_SPEED = 0.5;
/** The finished piece holds this long; anything still growing at MAX_MS − HOLD_MS fast-forwards. */
export const HOLD_MS = 1000, MAX_MS = 12000;
export const FPS = 30;
/** A keyframe every this many frames (2 s): scrubbing and upload transcoders stay quick. */
const GOP = 60;
/** Bitrate: fine ink lines over a grained ground need room. */
export const BITS_PER_SECOND = 12_000_000;
export const WORDMARK = 'sketch.syberlabs.io';
/** WebCodecs: main-thread time spent rendering and encoding per rAF, and the encode queue cap. */
const SLICE_MS = 10, MAX_QUEUE = 4;

/** H.264 profiles for WebCodecs, best first (High, Main, Constrained Baseline; level 4.0). */
export const AVC_CODECS: readonly string[] = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'];
/** MediaRecorder container/codec candidates, best first. */
export const MIME_CANDIDATES: readonly string[] = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

// ---------------------------------------------------------------------------- pure

/** The first supported MediaRecorder type, or null (pure; `supported` is MediaRecorder.isTypeSupported). */
export function pickMime(supported: (type: string) => boolean): string | null {
  for (const t of MIME_CANDIDATES) {
    try { if (supported(t)) return t; } catch { /* treated as unsupported */ }
  }
  return null;
}

/** File extension for a recording type. */
export function mimeExt(mime: string): 'mp4' | 'webm' {
  return /^video\/mp4/i.test(mime) ? 'mp4' : 'webm';
}

/**
 * Timelapse speed for a timeline of `t` ms of gap-capped drawing time (pure): aim at t / 1.5,
 * kept within 5–10 s, never slower than half speed.
 */
export function timelapseSpeed(t: number): number {
  if (!(t > 0)) return 1;
  const play = Math.min(PLAY_MAX_MS, Math.max(PLAY_MIN_MS, t / PREFERRED_SPEED));
  return Math.max(MIN_SPEED, t / play);
}

export interface TimelapseFrame { box: AABB; pxPerDoc: number; width: number; height: number }

/**
 * Framing (pure): the content plus a 10 % margin, centred in 1080 × 1080, or 1080 × 1350 when the
 * content is taller than wide; magnified at most `maxPx` px per doc unit.
 */
export function timelapseFrame(content: AABB, maxPx = Infinity): TimelapseFrame {
  const w = Math.max(1e-6, content.x1 - content.x0), h = Math.max(1e-6, content.y1 - content.y0);
  const width = WIDTH, height = h / w >= PORTRAIT_ASPECT ? PORTRAIT_H : WIDTH;
  const m = MARGIN * Math.max(w, h);
  let px = Math.min(width / (w + 2 * m), height / (h + 2 * m));
  if (maxPx > 0 && px > maxPx) px = maxPx;
  const cx = 0.5 * (content.x0 + content.x1), cy = 0.5 * (content.y0 + content.y1);
  const hw = 0.5 * width / px, hh = 0.5 * height / px;
  return { box: { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh }, pxPerDoc: px, width, height };
}

// ---------------------------------------------------------------------------- encoder choice

export type Encoder = { kind: 'webcodecs'; codec: string } | { kind: 'recorder'; mime: string };

/** The best way to encode here: WebCodecs H.264, else MediaRecorder, else null (no video). */
export async function pickEncoder(width = WIDTH, height = PORTRAIT_H): Promise<Encoder | null> {
  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
    for (const codec of AVC_CODECS) {
      try {
        const r = await VideoEncoder.isConfigSupported(encoderConfig(codec, width, height));
        if (r.supported) return { kind: 'webcodecs', codec };
      } catch { /* try the next */ }
    }
  }
  if (typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function') {
    const mime = pickMime(t => MediaRecorder.isTypeSupported(t));
    if (mime) return { kind: 'recorder', mime };
  }
  return null;
}

function encoderConfig(codec: string, width: number, height: number): VideoEncoderConfig {
  return { codec, width, height, bitrate: BITS_PER_SECOND, framerate: FPS, avc: { format: 'avc' } };
}

// ---------------------------------------------------------------------------- the frames

export interface TimelapseItem { r: StrokeRecipe; c: Cooked }

export interface TimelapsePlan {
  /** Start of each item on the replay clock (ms), from app/replay timeline(rs, timelapseSpeed). */
  starts: Float64Array;
  /** Speed: durations are scaled by 1 / k. */
  k: number;
}

export interface TimelapseOptions {
  ground: Ground;
  /** Bounds of every item's ink (doc). */
  content: AABB;
  encoder: Encoder;
  /** Frame scheduler: the app's single rAF loop. */
  loop: { add(fn: (now: number) => boolean, order?: number): () => void; request(): void };
  onProgress?(fraction: number): void;
  /** Polled every frame; true stops and resolves null. */
  cancelled?(): boolean;
  /** Optional canvas allocator (the ledger); falls back to document.createElement. */
  alloc?(w: number, h: number): HTMLCanvasElement | null;
  free?(c: HTMLCanvasElement): void;
}

export interface TimelapseResult { blob: Blob; mime: string; width: number; height: number; durationMs: number; frames: number }

/** Renders video frame i of the timelapse into one canvas (`out`). */
interface Film {
  readonly out: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  /** Render frame i; false once the hold after the last growth is complete (nothing drawn). */
  render(i: number): boolean;
  /** 0..1 of the expected length. */
  progress(i: number): number;
  release(): void;
}

function createFilm(items: readonly TimelapseItem[], plan: TimelapsePlan, o: TimelapseOptions): Film | null {
  const maxZ = items.reduce((z, it) => Math.max(z, it.r.z > 0 ? it.r.z : 1), 0) || 1;
  const f = timelapseFrame(o.content, MAX_MAGNIFY * maxZ);
  const W = f.width, H = f.height, g = o.ground, op = opFor(g), night = g === 'night';

  const owned: HTMLCanvasElement[] = [];
  const canvas = (w: number, h: number): HTMLCanvasElement => {
    let c = o.alloc ? o.alloc(w, h) : null;
    if (!c) { c = document.createElement('canvas'); c.width = w; c.height = h; }
    owned.push(c);
    return c;
  };
  const release = (): void => {
    for (const c of owned) { if (o.free) o.free(c); else { c.width = 0; c.height = 0; } }
    owned.length = 0;
  };
  const out = canvas(W, H), ground = canvas(W, H), base = canvas(W, H), dry = canvas(W, H), wet = canvas(W, H);
  const bw = Math.max(1, Math.ceil(W * BLOOM_SCALE)), bh = Math.max(1, Math.ceil(H * BLOOM_SCALE));
  const bloom = night ? [canvas(bw, bh), canvas(bw, bh)] : [];
  const chain: HTMLCanvasElement[] = [];
  if (night) for (let i = 0, w = bw, h = bh; i < 3; i++) { w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2)); chain.push(canvas(w, h)); }

  const octx = out.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null;
  const gctx = ground.getContext('2d');
  const bctx = base.getContext('2d');
  if (!octx || !gctx || !bctx) { release(); return null; }
  paintGround(gctx, W, H, g);
  // Paper tiles start white and multiply (DESIGN §6.2); Night tiles start transparent and add
  if (!night) { bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, W, H); }

  // the private live layer: video px, video clock, bakes into `base`
  let vt = 0;
  const bakes: { r: StrokeRecipe; c: Cooked; done: () => void }[] = [];
  const host: LiveHost = {
    dry, wet,
    dpr: () => 1,
    ground: () => g,
    camera: () => ({ cx: 0.5 * (f.box.x0 + f.box.x1), cy: 0.5 * (f.box.y0 + f.box.y1), scale: f.pxPerDoc, rot: 0 }),
    viewport: () => ({ w: W, h: H }),
    matrixFor: origin => regionMatrix(origin, f.box, f.pxPerDoc),
    inkTable: r => inkTableFor(r, g),
    bake: (r, c, done) => { bakes.push({ r, c, done }); },
    requestFrame: () => undefined,
    reducedMotion: () => false,
    now: () => vt,
  };
  const layer = createLiveLayer(host);
  const clip: AABB = { x0: 0, y0: 0, x1: W, y1: H };

  // bloom: rendered from `base` after a bake and cured in over CURE_MS, as on screen
  let front = 0, cureT0 = 0, bloomOn = false, bloomDirty = false;

  const wordmark = (ctx: CanvasRenderingContext2D): void => {
    const size = Math.round(W * 0.021), pad = Math.round(W * 0.037);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.font = `500 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
    try { ctx.letterSpacing = `${(size * 0.06).toFixed(1)}px`; } catch { /* older engines */ }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = night ? 'rgba(228, 232, 239, 0.42)' : 'rgba(36, 33, 28, 0.46)';
    ctx.fillText(WORDMARK, W - pad, H - pad);
    ctx.restore();
  };

  const composite = (): void => {
    const ctx = octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(ground, 0, 0);
    ctx.globalCompositeOperation = op;
    ctx.drawImage(base, 0, 0);
    if (night && bloomOn) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.globalCompositeOperation = 'lighter';
      const u = Math.min(1, Math.max(0, (vt - cureT0) / CURE_MS));
      // linear on both buffers, so their sum is constant where nothing changed
      if (u < 1) { ctx.globalAlpha = BLOOM_ALPHA * (1 - u); ctx.drawImage(bloom[1 - front], 0, 0, bw, bh, 0, 0, W, H); }
      ctx.globalAlpha = BLOOM_ALPHA * u;
      ctx.drawImage(bloom[front], 0, 0, bw, bh, 0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = op;
    }
    ctx.drawImage(dry, 0, 0);
    ctx.drawImage(wet, 0, 0);
    wordmark(ctx);
  };

  const n = items.length;
  const t0 = n ? plan.starts[0] : 0;
  let next = 0, ended = -1, ffDone = false;
  const play = (it: TimelapseItem): void => layer.play(it.r, it.c, { durationScale: 1 / plan.k });

  return {
    out, width: W, height: H,
    render(i) {
      vt = t0 + i * 1000 / FPS;
      if (ended >= 0 && vt > ended + HOLD_MS) return false;
      // strokes start on the timeline; anything still growing at the cap fast-forwards
      while (next < n && plan.starts[next] <= vt) play(items[next++]);
      if (!ffDone && vt - t0 >= MAX_MS - HOLD_MS) {
        ffDone = true;
        while (next < n) play(items[next++]);
        layer.fastForward();
      }
      layer.frame(vt);
      // strokes whose play finished bake into `base`, then leave #dry (their done())
      while (bakes.length) {
        const b = bakes.shift()!;
        drawInk(bctx, b.c, inkTableFor(b.r, g), regionMatrix(b.r.origin, f.box, f.pxPerDoc), b.r.form.form, { clipDev: clip });
        b.done();
        bloomDirty = night;
      }
      if (bloomDirty) {
        bloomDirty = false;
        if (bloomOn) front = 1 - front;
        bloomOf(base, bloom[front], chain);
        cureT0 = vt;
        bloomOn = true;
      }
      composite();
      if (ended < 0 && next >= n && layer.animating === 0) ended = vt;
      return true;
    },
    progress(i) {
      const v = t0 + i * 1000 / FPS;
      const end = ended >= 0 ? ended + HOLD_MS : Math.min(t0 + MAX_MS, Math.max(v, n ? plan.starts[n - 1] : 0) + HOLD_MS);
      return Math.min(1, (v - t0) / Math.max(1, end - t0));
    },
    release,
  };
}

// ---------------------------------------------------------------------------- recording

/** Record the timelapse (null when cancelled or when nothing could be recorded). */
export function recordTimelapse(items: readonly TimelapseItem[], plan: TimelapsePlan, o: TimelapseOptions): Promise<TimelapseResult | null> {
  const film = createFilm(items, plan, o);
  if (!film) return Promise.resolve(null);
  const run = o.encoder.kind === 'webcodecs' ? encodeFrames(film, o.encoder.codec, o) : recordRealtime(film, o.encoder.mime, o);
  return run.finally(() => film.release());
}

/** WebCodecs: every frame at its exact timestamp, as fast as the device allows, then MP4. */
function encodeFrames(film: Film, codec: string, o: TimelapseOptions): Promise<TimelapseResult | null> {
  return new Promise(resolve => {
    const samples: Mp4Sample[] = [];
    let avcC: Uint8Array | null = null;
    let color: ReturnType<typeof nclx> = null;
    let failed: unknown = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        const d = meta?.decoderConfig;
        if (d && d.description && !avcC) {
          const desc = d.description;
          avcC = ArrayBuffer.isView(desc)
            ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength).slice()
            : new Uint8Array(desc).slice();
          color = nclx(d.colorSpace);
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({ data, key: chunk.type === 'key', pts: chunk.timestamp });
      },
      error: e => { failed = e; },
    });
    try { enc.configure(encoderConfig(codec, film.width, film.height)); } catch (e) { failed = e; }
    let i = 0, finished = false;
    const finish = (ok: boolean): void => {
      if (finished) return;
      finished = true;
      remove();
      if (!ok) { try { enc.close(); } catch { /* closed */ } resolve(null); return; }
      enc.flush().then(() => {
        enc.close();
        if (failed || !avcC || !samples.length) { if (failed) console.error('[rise] timelapse encoder', failed); resolve(null); return; }
        const parts = muxMp4({ width: film.width, height: film.height, fps: FPS, avcC, color, samples });
        resolve({ blob: new Blob(parts as BlobPart[], { type: 'video/mp4' }), mime: 'video/mp4', width: film.width, height: film.height, durationMs: samples.length * 1000 / FPS, frames: samples.length });
      }, e => { console.error('[rise] timelapse encoder', e); resolve(null); });
    };
    const step = (): boolean => {
      if (finished) return false;
      if (failed || (o.cancelled && o.cancelled())) { if (failed) console.error('[rise] timelapse encoder', failed); finish(false); return false; }
      const t = performance.now();
      while (performance.now() - t < SLICE_MS && enc.encodeQueueSize < MAX_QUEUE) {
        if (!film.render(i)) { finish(true); return false; }
        const frame = new VideoFrame(film.out, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
        enc.encode(frame, { keyFrame: i % GOP === 0 });
        frame.close();
        if (o.onProgress) o.onProgress(film.progress(i));
        i++;
      }
      return true;
    };
    const remove = o.loop.add(step, 20);
    o.loop.request();
  });
}

/**
 * MediaRecorder fallback: frames go out in real time and the recorder stamps them with the wall
 * clock, so the frame index follows the wall clock (from the recorder's start, minus time hidden)
 * and a slow frame drops frames instead of changing the speed.
 */
function recordRealtime(film: Film, mime: string, o: TimelapseOptions): Promise<TimelapseResult | null> {
  return new Promise(resolve => {
    let stream: MediaStream, rec: MediaRecorder;
    try {
      stream = film.out.captureStream(0);
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITS_PER_SECOND });
    } catch (err) {
      console.error('[rise] timelapse recorder', err);
      resolve(null);
      return;
    }
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const push = (): void => { if (track.requestFrame) track.requestFrame(); };
    const chunks: Blob[] = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    let started = false, finished = false, t0 = -1, pausedAt = -1, pausedTotal = 0, last = -1, frames = 0;

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        if (pausedAt < 0 && t0 >= 0) { pausedAt = performance.now(); try { if (rec.state === 'recording') rec.pause(); } catch { /* ignore */ } }
      } else if (pausedAt >= 0) {
        pausedTotal += performance.now() - pausedAt;
        pausedAt = -1;
        try { if (rec.state === 'paused') rec.resume(); } catch { /* ignore */ }
        o.loop.request();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const finish = (ok: boolean): void => {
      if (finished) return;
      finished = true;
      remove();
      document.removeEventListener('visibilitychange', onVisibility);
      const done = (): void => {
        for (const t of stream.getTracks()) t.stop();
        if (!ok || !chunks.length) { resolve(null); return; }
        const type = mime.split(';')[0];
        resolve({ blob: new Blob(chunks, { type }), mime: type, width: film.width, height: film.height, durationMs: (last + 1) * 1000 / FPS, frames });
      };
      if (rec.state === 'inactive') { done(); return; }
      rec.onstop = done;
      try { rec.stop(); } catch { done(); }
    };

    const step = (): boolean => {
      if (finished) return false;
      if (o.cancelled && o.cancelled()) { finish(false); return false; }
      if (pausedAt >= 0) return false;  // hidden: the visibility handler resumes the loop
      if (!started) {
        started = true;
        film.render(0);
        rec.onstart = () => { t0 = performance.now(); o.loop.request(); };
        try { rec.start(); } catch { finish(false); return false; }
      }
      if (t0 < 0) { push(); return true; }  // the first frame until the recorder runs
      const i = Math.floor((performance.now() - t0 - pausedTotal) * FPS / 1000);
      if (i === last) return true;        // between video frames
      last = i;
      if (!film.render(i)) { finish(true); return false; }
      push();
      frames++;
      if (o.onProgress) o.onProgress(film.progress(i));
      return true;
    };
    const remove = o.loop.add(step, 20);
    o.loop.request();
  });
}
