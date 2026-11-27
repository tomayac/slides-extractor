// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// ffmpeg helpers: probing, audio extraction and segmentation, still frames,
// and animated slide assets (animated WebP and muted MP4 clips).

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run, streamRecords } from './proc.js';

export async function probe(video) {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height:format=duration',
    '-of',
    'json',
    video,
  ]);
  const j = JSON.parse(out.toString());
  return {
    width: j.streams[0].width,
    height: j.streams[0].height,
    duration: +j.format.duration,
  };
}

const SAMPLE_RATE = 16000;

/**
 * Writes 16 kHz mono float32 PCM (what Whisper and Gemma 4 expect) to
 * `out`, and returns cut points that split the audio into segments of at
 * most `maxLen` seconds at the quietest moment of each window.
 */
export async function extractAudio(
  video,
  out,
  { maxLen = 28, minLen = 14 } = {},
) {
  const chunks = [];
  await streamRecords(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      video,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      '-',
    ],
    4 * 1600,
    (buf) => chunks.push(Buffer.from(buf)),
  );
  const pcm = Buffer.concat(chunks);
  await writeFile(out, pcm);
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);

  // Energy per 50 ms window.
  const win = SAMPLE_RATE / 20;
  const energy = new Float32Array(Math.floor(samples.length / win));
  for (let i = 0; i < energy.length; i++) {
    let s = 0;
    for (let j = i * win; j < (i + 1) * win; j++) s += samples[j] * samples[j];
    energy[i] = s / win;
  }
  // Pick each cut at the quietest 300 ms between `minLen` and `maxLen`.
  const perSec = 20;
  const span = 6; // 300 ms
  const total = energy.length;
  const cuts = [0];
  let pos = 0;
  while (total - pos > maxLen * perSec) {
    let best = -1;
    let bestE = Infinity;
    for (let i = pos + minLen * perSec; i < pos + maxLen * perSec - span; i++) {
      let e = 0;
      for (let k = 0; k < span; k++) e += energy[i + k];
      if (e < bestE) ((bestE = e), (best = i + span / 2));
    }
    pos = best;
    cuts.push(+(pos / perSec).toFixed(2));
  }
  const duration = samples.length / SAMPLE_RATE;
  const segments = cuts.map((start, i) => ({
    start,
    end: i + 1 < cuts.length ? cuts[i + 1] : +duration.toFixed(2),
  }));
  return { sampleRate: SAMPLE_RATE, duration, segments };
}

const cropFilter = (crop) =>
  crop && !crop.full ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}` : null;

/** Saves the frame at `t` seconds, cropped, as a JPEG (or PNG for `.png`). */
export async function stillFrame(video, t, out, crop, width) {
  const vf = [
    cropFilter(crop),
    width ? `scale=${width}:-2:flags=lanczos` : null,
  ]
    .filter(Boolean)
    .join(',');
  await run('ffmpeg', [
    '-v',
    'error',
    '-ss',
    String(t),
    '-i',
    video,
    '-frames:v',
    '1',
    ...(vf ? ['-vf', vf] : []),
    '-q:v',
    '2',
    '-y',
    out,
  ]);
}

/**
 * Saves a still per build step (`<base>-s1.jpg`, …), which the slide deck
 * steps through like fragments, and an animated WebP of the steps, each
 * held for `holdMs` and the last one longer. Returns the stills' file names.
 */
export async function buildAnimation(
  video,
  states,
  base,
  crop,
  { holdMs = 1400 } = {},
) {
  const files = [];
  for (let i = 0; i < states.length; i++) {
    const f = `${base}-s${i + 1}.jpg`;
    await stillFrame(video, states[i].t, f, crop);
    files.push(f);
  }
  const args = ['-loop', '0', '-lossy', '-q', '80', '-m', '4'];
  files.forEach((f, i) =>
    args.push('-d', String(i === files.length - 1 ? holdMs * 2.5 : holdMs), f),
  );
  args.push('-o', `${base}-build.webp`);
  await run('img2webp', args);
  return files.map((f) => f.split('/').at(-1));
}

/**
 * Cuts a muted, looping-friendly MP4 clip and an animated WebP of a motion
 * stretch. Long stretches are capped at `maxLen` seconds.
 */
export async function motionClip(
  video,
  start,
  end,
  outBase,
  crop,
  tmpDir,
  { width = 960, maxLen = 30, webpFps = 8 } = {},
) {
  const len = Math.min(end - start, maxLen);
  const vf = [cropFilter(crop), `scale=${width}:-2:flags=lanczos`]
    .filter(Boolean)
    .join(',');
  await run('ffmpeg', [
    '-v',
    'error',
    '-ss',
    String(start),
    '-i',
    video,
    '-t',
    String(len),
    '-an',
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '26',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-y',
    `${outBase}.mp4`,
  ]);
  // Animated WebP for places where video doesn't play (Markdown, email).
  await mkdir(tmpDir, { recursive: true });
  const webpLen = Math.min(len, 12);
  const small = [
    cropFilter(crop),
    `fps=${webpFps}`,
    `scale=${Math.min(width, 640)}:-2:flags=lanczos`,
  ]
    .filter(Boolean)
    .join(',');
  await run('ffmpeg', [
    '-v',
    'error',
    '-ss',
    String(start),
    '-i',
    video,
    '-t',
    String(webpLen),
    '-an',
    '-vf',
    small,
    '-y',
    join(tmpDir, 'f%04d.png'),
  ]);
  const { readdir } = await import('node:fs/promises');
  const frames = (await readdir(tmpDir))
    .filter((f) => f.endsWith('.png'))
    .sort();
  const args = [
    '-loop',
    '0',
    '-lossy',
    '-q',
    '55',
    '-m',
    '4',
    '-d',
    String(Math.round(1000 / webpFps)),
  ];
  for (const f of frames) args.push(join(tmpDir, f));
  args.push('-o', `${outBase}.webp`);
  if (frames.length) await run('img2webp', args);
  await rm(tmpDir, { recursive: true, force: true });
}
