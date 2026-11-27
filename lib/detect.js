// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Slide detection on downscaled grayscale frames.
//
// 1. `analyzeLayout()` works out how the talk was recorded and where the
//    slides are. Recordings often show the slides next to the speaker, under
//    a title overlay. Per pixel, it measures how often the value changes
//    between keyframes: the speaker changes almost every time, overlays never
//    change, and slides change in occasional steps. The largest rectangle of
//    "occasional step" pixels is the slide region. Repeating this on separate
//    time windows tells a fixed camera mix from one that changes.
// 2. `segmentSlides()` walks frames cropped to that region and splits them
//    into stable states, groups states into slides (a small change on top of
//    the previous state is a build step, a large one is a new slide), and
//    flags stretches of continuous motion (videos, demos, animations).

import { run, streamRecords } from './proc.js';

const PROBE_W = 384;
const PROBE_H = 216;

/**
 * Reads grayscale frames of `w`×`h` at `fps` from `video`, optionally cropped.
 * With `keyframes`, decodes only keyframes (every few seconds), which is
 * about twenty times faster and plenty for finding the slide region.
 */
export async function readFrames(
  video,
  { fps, w, h, crop, onProgress, duration, keyframes },
) {
  const filters = [];
  if (crop) filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  if (!keyframes) filters.push(`fps=${fps}`);
  filters.push(`scale=${w}:${h}:flags=area`, 'format=gray');
  const frames = [];
  const input = keyframes
    ? ['-skip_frame', 'nokey', '-i', video, '-fps_mode', 'passthrough']
    : ['-i', video];
  await streamRecords(
    'ffmpeg',
    [
      '-v',
      'error',
      ...input,
      '-an',
      '-vf',
      filters.join(','),
      '-f',
      'rawvideo',
      '-',
    ],
    w * h,
    (buf, i) => {
      frames.push(new Uint8Array(buf));
      if (onProgress && duration && fps && i % 20 === 0)
        onProgress(Math.min(1, i / fps / duration));
    },
  );
  return frames;
}

/** Presentation times of the keyframes, matching `readFrames({ keyframes })`. */
async function keyframeTimes(video) {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-skip_frame',
    'nokey',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=pts_time',
    '-of',
    'csv=p=0',
    video,
  ]);
  return out
    .toString()
    .split('\n')
    .map((l) => parseFloat(l))
    .filter((t) => Number.isFinite(t));
}

const intersectionOverUnion = (a, b) => {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i);
};

/** Per pixel: the share of consecutive sample pairs with a visible change. */
function changeRate(frames, size) {
  const rate = new Float32Array(size);
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f - 1];
    const b = frames[f];
    for (let p = 0; p < size; p++) if (Math.abs(a[p] - b[p]) > 14) rate[p]++;
  }
  for (let p = 0; p < size; p++) rate[p] /= Math.max(1, frames.length - 1);
  return rate;
}

/** The slide rectangle (probe coordinates) for a set of frames, or null. */
function regionOf(frames, w, h) {
  const rate = changeRate(frames, w * h);
  // Slide pixels change sometimes, but far less often than the speaker.
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++)
    mask[p] = rate[p] > 0.01 && rate[p] < 0.5 ? 1 : 0;
  const rect = largestRectangle(mask, w, h);
  if (!rect || rect.w * rect.h < w * h * 0.15) return { rect: null, rate };
  return { rect: refineEdges(frames, w, h, rect), rate };
}

/**
 * Share of a frame's pixels that sit in flat areas. Slides are mostly flat
 * color with sharp edges; camera footage has texture and noise everywhere.
 */
export function flatness(frame, w, h) {
  let flat = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const p = y * w + x;
      if (
        Math.abs(frame[p] - frame[p + 1]) + Math.abs(frame[p] - frame[p + w]) <
        3
      )
        flat++;
    }
  }
  return flat / ((w - 1) * (h - 1));
}

function cropFrame(frame, w, rect) {
  const out = new Uint8Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++)
    out.set(
      frame.subarray(
        (rect.y + y) * w + rect.x,
        (rect.y + y) * w + rect.x + rect.w,
      ),
      y * rect.w,
    );
  return out;
}

/**
 * Works out how the talk is recorded and where the slides are. Strategies:
 *
 * - `fixed`: a static camera mix (split view, speaker circle, picture in
 *   picture). One region for the whole video; checked by finding the region
 *   again in separate time windows and requiring they agree.
 * - `fullscreen`: the slides fill the frame, possibly with cuts to a camera.
 * - `varying`: the windows disagree (the mix changes during the talk, or the
 *   camera follows the speaker). Each window gets its own region.
 *
 * Also returns per-keyframe evidence (does the frame match the layout's
 * static overlay, how slide-like is the region) that `scoreSlides()` uses to
 * flag camera shots and other non-slide moments.
 */
export async function analyzeLayout(video, { width, height, onProgress }) {
  const w = PROBE_W;
  const h = PROBE_H;
  const [frames, times] = await Promise.all([
    readFrames(video, { w, h, keyframes: true }),
    keyframeTimes(video),
  ]);
  onProgress?.(1);
  const n = Math.min(frames.length, times.length);
  frames.length = n;
  const fullRect = { x: 0, y: 0, w, h };
  const toVideo = (rect) => {
    if (!rect) return { x: 0, y: 0, w: width, h: height, full: true };
    const sx = width / w;
    const sy = height / h;
    const even = (v) => Math.max(0, Math.round(v / 2) * 2);
    // Step inside the border a little: the probe is coarse, and slides often
    // have rounded corners or a frame that would bleed into the crop.
    const inset = Math.max(3, Math.round(rect.w * sx * 0.0035));
    const r = {
      x: even(rect.x * sx + inset),
      y: even(rect.y * sy + inset),
      w: even(rect.w * sx - 2 * inset),
      h: even(rect.h * sy - 2 * inset),
    };
    // Treat nearly full frames as full frames.
    return r.w > width * 0.94 && r.h > height * 0.94
      ? { x: 0, y: 0, w: width, h: height, full: true }
      : r;
  };
  if (n < 10)
    return {
      layout: 'fullscreen',
      region: toVideo(null),
      windows: [],
      keyframes: [],
    };

  const { rect, rate } = regionOf(frames, w, h);

  // Heuristic: a fixed camera mix yields the same region in every window.
  const count = Math.max(1, Math.min(6, Math.floor(n / 40)));
  const windows = [];
  for (let i = 0; i < count; i++) {
    const a = Math.floor((i * n) / count);
    const b = Math.floor(((i + 1) * n) / count);
    const r = regionOf(frames.slice(a, b), w, h).rect;
    windows.push({
      start: i ? times[a] : 0,
      end: i + 1 < count ? times[b] : Infinity,
      rect: r,
      iou: r && rect ? intersectionOverUnion(r, rect) : 0,
    });
  }
  const agree = windows.filter((x) => x.iou > 0.8).length / count;
  // Heuristic: slides that fill the frame keep whole frames mostly flat,
  // even with a speaker bubble floating over them.
  const fullFlat = frames.map((f) => flatness(f, w, h)).sort((a, b) => a - b);
  const medianFlat = fullFlat[fullFlat.length >> 1];
  let layout;
  if (!rect || (rect.w * rect.h) / (w * h) > 0.88) layout = 'fullscreen';
  else if (agree >= 0.6) layout = 'fixed';
  else if (medianFlat > 0.5) layout = 'fullscreen';
  else layout = 'varying';

  // Static overlay template: pixels outside the region that (nearly) never
  // change, e.g. the event branding around a split view. A frame whose
  // template pixels differ is not in the usual layout (a full-screen cut).
  const inside = (p, r) => {
    const x = p % w;
    const y = (p / w) | 0;
    return r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  };
  const templatePixels = [];
  if (layout === 'fixed') {
    for (let p = 0; p < w * h; p++)
      if (!inside(p, rect) && rate[p] < 0.03) templatePixels.push(p);
  }
  const template = new Uint8Array(templatePixels.length);
  templatePixels.forEach((p, i) => {
    const values = frames.map((f) => f[p]).sort((a, b) => a - b);
    template[i] = values[values.length >> 1];
  });

  const keyframes = frames.map((f, i) => {
    let match = null;
    if (templatePixels.length > 200) {
      let ok = 0;
      templatePixels.forEach(
        (p, k) => (ok += Math.abs(f[p] - template[k]) < 20 ? 1 : 0),
      );
      match = +(ok / templatePixels.length).toFixed(3);
    }
    const r =
      layout === 'fixed'
        ? rect
        : layout === 'varying'
          ? windows.find((x) => times[i] >= x.start && times[i] < x.end)
              ?.rect || fullRect
          : fullRect;
    return {
      t: +times[i].toFixed(2),
      match,
      flat: +flatness(cropFrame(f, w, r), r.w, r.h).toFixed(3),
    };
  });

  return {
    layout,
    agreement: +agree.toFixed(2),
    flatness: +medianFlat.toFixed(3),
    region:
      layout === 'fixed'
        ? toVideo(rect)
        : layout === 'varying'
          ? toVideo(rect)
          : toVideo(null),
    windows: windows.map((x) => ({
      start: x.start,
      end: x.end === Infinity ? null : x.end,
      region: toVideo(x.rect),
      iou: +x.iou.toFixed(2),
    })),
    keyframes,
    templateSize: templatePixels.length,
  };
}

/**
 * Flags each slide as `slide` or `camera` from the layout evidence: frames
 * that break the fixed layout's overlay, or that look like camera footage
 * (little flat area), are probably not slides. The browser's Gemma pass makes
 * the final call; this sets the default.
 */
export function scoreSlides(slides, layout) {
  for (const s of slides) {
    // Keyframes inside the slide, or the nearest one for short slides.
    let kf = layout.keyframes.filter((k) => k.t >= s.start && k.t < s.end);
    if (!kf.length && layout.keyframes.length) {
      const mid = (s.start + s.end) / 2;
      const near = layout.keyframes.reduce((a, k) =>
        Math.abs(k.t - mid) < Math.abs(a.t - mid) ? k : a,
      );
      if (Math.abs(near.t - mid) < 4) kf = [near];
    }
    const avg = (key) => {
      const v = kf
        .map((k) => k[key])
        .filter((x) => x !== null && x !== undefined);
      return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
    };
    s.match = avg('match');
    s.flat ??= avg('flat');
    const offLayout = s.match !== null && s.match < 0.6;
    const cameraLike = s.flat !== null && s.flat < 0.25;
    s.kind = offLayout
      ? 'other'
      : cameraLike && !s.states.length
        ? 'camera'
        : cameraLike
          ? 'maybe'
          : 'slide';
    if (layout.layout === 'varying') {
      const win = layout.windows.find(
        (x) => s.start >= x.start && (x.end === null || s.start < x.end),
      );
      if (win) s.region = win.region;
    }
  }
  return slides;
}

/**
 * Snaps each side of `rect` to the slide's border. The border is the one
 * edge that sits in the same place in every frame, so it stands out in the
 * time-averaged gradient, while the speaker's and the slides' own edges move
 * around and average out.
 */
function refineEdges(frames, w, h, rect) {
  const n = frames.length;
  const gx = new Float32Array(w * h); // mean |horizontal gradient|
  const gy = new Float32Array(w * h); // mean |vertical gradient|
  for (const f of frames) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        gx[p] += Math.abs(f[p + 1] - f[p - 1]);
        gy[p] += Math.abs(f[p + w] - f[p - w]);
      }
    }
  }
  for (let p = 0; p < w * h; p++) ((gx[p] /= n), (gy[p] /= n));

  // Profile of a candidate vertical border at column `x`, measured along the
  // rows of the rectangle; likewise for horizontal borders.
  const colScore = (x, y0, y1) => {
    let s = 0;
    for (let y = y0; y < y1; y++) s += gx[y * w + x];
    return s / (y1 - y0);
  };
  const rowScore = (y, x0, x1) => {
    let s = 0;
    for (let x = x0; x < x1; x++) s += gy[y * w + x];
    return s / (x1 - x0);
  };
  // Search a band around the current edge (the region often overshoots into
  // static background, rarely undershoots).
  const best = (from, to, score) => {
    let bi = -1;
    let bs = 0;
    const scores = [];
    for (let i = Math.max(1, from); i <= Math.min(to, score.max); i++) {
      const s = score(i);
      scores.push(s);
      if (s > bs) ((bs = s), (bi = i));
    }
    scores.sort((a, b) => a - b);
    const median = scores[scores.length >> 1] || 0;
    // Only snap to a clear, persistent border.
    return bs > Math.max(6, median * 2.5) ? bi : -1;
  };
  const bandX = Math.round(rect.w * 0.25);
  const bandY = Math.round(rect.h * 0.25);
  const { x, y } = rect;
  const x1 = x + rect.w;
  const y1 = y + rect.h;
  const inY0 = y + Math.round(rect.h * 0.15);
  const inY1 = y1 - Math.round(rect.h * 0.15);
  const inX0 = x + Math.round(rect.w * 0.15);
  const inX1 = x1 - Math.round(rect.w * 0.15);
  const col = (i) => colScore(i, inY0, inY1);
  col.max = w - 2;
  const row = (i) => rowScore(i, inX0, inX1);
  row.max = h - 2;
  const left = best(x - 6, x + bandX, col);
  const right = best(x1 - bandX, x1 + 6, col);
  const top = best(y - 6, y + bandY, row);
  const bottom = best(y1 - bandY, y1 + 6, row);
  // The gradient peaks one pixel outside the slide on each side; step in.
  const nx = left >= 0 ? left + 1 : x;
  const nx1 = right >= 0 ? right : x1;
  const ny = top >= 0 ? top + 1 : y;
  const ny1 = bottom >= 0 ? bottom : y1;
  if (nx1 - nx < rect.w * 0.5 || ny1 - ny < rect.h * 0.5) return rect;
  return { x: nx, y: ny, w: nx1 - nx, h: ny1 - ny };
}

/**
 * Largest axis-aligned rectangle whose cells are mostly set in `mask`. Uses
 * the histogram method on a smoothed mask, so a few unset pixels (a slide's
 * never-changing logo) don't split the region.
 */
function largestRectangle(mask, w, h) {
  // Smooth: a cell counts if most of its 5×5 neighborhood is set.
  const r = 2;
  const smooth = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += mask[yy * w + xx];
          c++;
        }
      }
      smooth[y * w + x] = s / c > 0.35 ? 1 : 0;
    }
  }
  // Fill holes: a column run between set cells in the same row is kept when
  // short, which makes the histogram method tolerant of static slide areas.
  const heights = new Int32Array(w);
  let best = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++)
      heights[x] = smooth[y * w + x] ? heights[x] + 1 : 0;
    const stack = [];
    for (let x = 0; x <= w; x++) {
      const cur = x === w ? 0 : heights[x];
      let start = x;
      while (stack.length && stack.at(-1).h >= cur) {
        const top = stack.pop();
        const area = top.h * (x - top.x);
        if (!best || area > best.area) {
          best = { area, x: top.x, y: y - top.h + 1, w: x - top.x, h: top.h };
        }
        start = top.x;
      }
      stack.push({ x: start, h: cur });
    }
  }
  return best;
}

/**
 * Finds "live" cells: grid cells that change in most samples within ±30 s,
 * such as a speaker bubble over full-screen slides. Slide content changes in
 * steps and never looks like that. Returns, per frame, a flag per cell
 * (dilated by one cell to cover the bubble's edges), and the pixel→cell map.
 */
function liveCells(
  frames,
  w,
  fps,
  pixelThreshold,
  { cellSize = 16, windowSec = 30, minRate = 0.5 } = {},
) {
  const n = frames.length;
  const h = frames[0].length / w;
  const cw = Math.ceil(w / cellSize);
  const ch = Math.ceil(h / cellSize);
  const cells = cw * ch;
  const cellOf = new Uint16Array(w * h);
  const cellPixels = new Uint32Array(cells);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = Math.floor(y / cellSize) * cw + Math.floor(x / cellSize);
      cellOf[y * w + x] = c;
      cellPixels[c]++;
    }
  }
  // prefix[i * cells + c]: frames before `i` in which cell `c` changed.
  const prefix = new Int32Array((n + 1) * cells);
  const count = new Uint32Array(cells);
  for (let i = 0; i < n; i++) {
    count.fill(0);
    if (i > 0) {
      const a = frames[i - 1];
      const b = frames[i];
      for (let p = 0; p < a.length; p++)
        if (Math.abs(a[p] - b[p]) > pixelThreshold) count[cellOf[p]]++;
    }
    for (let c = 0; c < cells; c++) {
      prefix[(i + 1) * cells + c] =
        prefix[i * cells + c] + (count[c] > cellPixels[c] * 0.08 ? 1 : 0);
    }
  }
  const half = Math.round(windowSec * fps);
  const at = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    const raw = new Uint8Array(cells);
    for (let c = 0; c < cells; c++) {
      raw[c] =
        (prefix[hi * cells + c] - prefix[lo * cells + c]) / (hi - lo) > minRate
          ? 1
          : 0;
    }
    const dil = new Uint8Array(cells);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (!raw[y * cw + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy >= 0 && yy < ch && xx >= 0 && xx < cw) dil[yy * cw + xx] = 1;
          }
        }
      }
    }
    at[i] = dil;
  }
  return { at, cellOf };
}

/**
 * Splits the cropped frames into slides. Returns slides with `start`/`end`
 * times, the times of their stable states, and motion stretches.
 */
export function segmentSlides(frames, fps, opts = {}) {
  const {
    pixelThreshold = 18, // gray-level change that counts as a changed pixel
    stableMax = 0.004, // share of changed pixels between "identical" frames
    minStable = 1.0, // seconds a state must hold to count as a state
    newSlide = 0.18, // share of changed pixels that starts a new slide
    minMotion = 2.0, // seconds of continuous change that count as motion
    minAdditivity = 0.75, // share of changed pixels that were background, for a build step
    minSlide = 2.0, // seconds; shorter slides are treated as transitions
    smallChange = 0.1, // share of changed pixels below which a quick change is a demo step
    shortHold = 10, // seconds; states held shorter than this are demo steps
  } = opts;
  const n = frames.length;
  const size = frames[0]?.length ?? 0;
  const live =
    opts.maskLive && opts.width
      ? liveCells(frames, opts.width, fps, pixelThreshold)
      : null;
  // Share of changed pixels between frames `i` and `j`, ignoring live video.
  const diff = (i, j) => {
    const a = frames[i];
    const b = frames[j];
    let c = 0;
    if (live) {
      const li = live.at[i];
      const lj = live.at[j];
      for (let p = 0; p < size; p++) {
        const cell = live.cellOf[p];
        if (!li[cell] && !lj[cell] && Math.abs(a[p] - b[p]) > pixelThreshold)
          c++;
      }
    } else {
      for (let p = 0; p < size; p++)
        if (Math.abs(a[p] - b[p]) > pixelThreshold) c++;
    }
    return c / size;
  };

  // Consecutive diffs.
  const d = new Float32Array(n);
  for (let i = 1; i < n; i++) d[i] = diff(i - 1, i);

  // Stable runs: maximal runs of frames that barely change.
  const runs = [];
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || d[i] > stableMax) {
      if ((i - runStart) / fps >= minStable)
        runs.push({ a: runStart, b: i - 1 });
      runStart = i;
    }
  }
  // Merge neighboring runs that are near-identical (a cursor blinked).
  const states = [];
  for (const run of runs) {
    const prev = states.at(-1);
    if (prev && diff(prev.b, run.a) <= stableMax * 2) prev.b = run.b;
    else states.push({ ...run });
  }

  // Group states into slides. Two kinds of change stay on the same slide:
  // - A build step adds content on the slide's background, so the pixels
  //   that change were background before. A new slide replaces content.
  // - A demo step is a small change between states that flick by (a tooltip
  //   moves, a page scrolls a bit). Code slides that swap a few lines change
  //   just as few pixels, but each stays up for a while.
  const background = (f) => {
    const hist = new Uint32Array(256);
    for (let p = 0; p < size; p++) hist[f[p]]++;
    let mode = 0;
    for (let v = 1; v < 256; v++) if (hist[v] > hist[mode]) mode = v;
    return mode;
  };
  const additivity = (i, j) => {
    const a = frames[i];
    const b = frames[j];
    const bg = background(a);
    let changed = 0;
    let fromBackground = 0;
    for (let p = 0; p < size; p++) {
      if (live && (live.at[i][live.cellOf[p]] || live.at[j][live.cellOf[p]]))
        continue;
      if (Math.abs(a[p] - b[p]) > pixelThreshold) {
        changed++;
        if (Math.abs(a[p] - bg) <= 12) fromBackground++;
      }
    }
    return changed ? fromBackground / changed : 1;
  };
  const slides = [];
  for (let s = 0; s < states.length; s++) {
    const st = states[s];
    const rep = Math.round((st.a + st.b) / 2);
    const prev = slides.at(-1);
    const prevState = prev?.states.at(-1);
    const change = prevState ? diff(prevState.b, st.a) : 1;
    const gap = prevState ? (st.a - prevState.b) / fps : 0;
    const state = { a: st.a, b: st.b, rep };
    const add = prevState ? additivity(prevState.b, st.a) : 1;
    // How long each side stays up: slides are held, demo states flick by.
    const held = prevState
      ? Math.min(prevState.b - prevState.a + 1, st.b - st.a + 1) / fps
      : Infinity;
    if (process.env.DEBUG_DETECT)
      console.log(
        'boundary',
        (st.a / fps).toFixed(1),
        'change',
        change.toFixed(3),
        'add',
        add.toFixed(2),
        'held',
        held,
      );
    const demoStep = change < smallChange && held < shortHold;
    const buildStep = change < newSlide && add >= minAdditivity;
    if (prev && gap < minMotion && (demoStep || buildStep)) {
      prev.states.push(state);
    } else {
      slides.push({ states: [state], motion: [] });
    }
  }

  // Very short slides without motion are mostly cross-fade frames between
  // two slides; fold them into the slide before.
  for (let i = slides.length - 1; i > 0; i--) {
    const sl = slides[i];
    const dur = (sl.states.at(-1).b - sl.states[0].a + 1) / fps;
    const nextStart = slides[i + 1]?.states[0].a;
    const tillNext =
      nextStart !== undefined ? (nextStart - sl.states[0].a) / fps : Infinity;
    if (dur < minSlide && tillNext < minSlide * 1.5) slides.splice(i, 1);
  }

  // Motion: stretches with no stable state that last long enough. Attach each
  // to the slide it follows (or precedes, at the start).
  const motion = [];
  let prevEnd = 0;
  for (const st of states) {
    if ((st.a - prevEnd) / fps >= minMotion)
      motion.push({ a: prevEnd, b: st.a - 1 });
    prevEnd = st.b + 1;
  }
  if ((n - prevEnd) / fps >= minMotion) motion.push({ a: prevEnd, b: n - 1 });

  const t = (i) => +(i / fps).toFixed(2);
  const w = opts.width;
  const out = slides.map((s) => ({
    start: t(s.states[0].a),
    end: t(s.states.at(-1).b + 1),
    states: s.states.map((x) => ({
      start: t(x.a),
      end: t(x.b + 1),
      t: t(x.rep),
    })),
    motion: [],
    flat: w
      ? +flatness(frames[s.states.at(-1).rep], w, size / w).toFixed(3)
      : null,
  }));
  for (const m of motion) {
    const start = t(m.a);
    const end = t(m.b + 1);
    // A long motion stretch is its own slide (a video or live demo).
    let owner = out.findLast((s) => s.start <= start);
    if (!owner || end - start > 8) {
      const slide = { start, end, states: [], motion: [{ start, end }] };
      const idx = out.findIndex((s) => s.start > start);
      out.splice(idx === -1 ? out.length : idx, 0, slide);
      continue;
    }
    owner.motion.push({ start, end });
    owner.end = Math.max(owner.end, end);
  }
  // Each slide lasts until the next one starts.
  for (let i = 0; i < out.length; i++) {
    out[i].end = i + 1 < out.length ? out[i + 1].start : t(n);
  }
  if (out.length) out[0].start = 0;
  return { slides: out, stableCount: states.length };
}
