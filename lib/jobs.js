// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// The server-side pipeline for one talk: download, audio extraction, slide
// region and slide detection, and rendering of slide assets. Everything the
// models need runs in the browser; this only does the media work.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  analyzeLayout,
  readFrames,
  scoreSlides,
  segmentSlides,
} from './detect.js';
import {
  buildAnimation,
  extractAudio,
  motionClip,
  probe,
  stillFrame,
} from './media.js';
import { run } from './proc.js';

export const DATA = new URL('../data/', import.meta.url).pathname;
const SEG_FPS = 2;
const SEG_W = 256;
const SEG_H = 144;

const jobs = new Map(); // id → job (in memory, mirrored to job.json)
const running = new Set();

export const validId = (id) => /^[\w-]{1,64}$/.test(id);
const dir = (id) => join(DATA, id);

async function save(job) {
  await writeFile(join(dir(job.id), 'job.json'), JSON.stringify(job, null, 2));
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  // Progress updates are frequent; persist them lazily.
  clearTimeout(job._t);
  const timer = setTimeout(() => save(job).catch(() => {}), 500);
  Object.defineProperty(job, '_t', {
    value: timer,
    enumerable: false,
    writable: true,
  });
}

export async function listJobs() {
  await mkdir(DATA, { recursive: true });
  const out = [];
  for (const id of await readdir(DATA)) {
    const job = await getJob(id);
    if (job) out.push(publicJob(job));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getJob(id) {
  if (!validId(id)) return null;
  if (jobs.has(id)) return jobs.get(id);
  try {
    const job = JSON.parse(await readFile(join(dir(id), 'job.json'), 'utf8'));
    // A job that was running when the server stopped is not running anymore.
    if (!['ready', 'error'].includes(job.stage)) job.stage = 'interrupted';
    jobs.set(id, job);
    return job;
  } catch {
    return null;
  }
}

export function publicJob(job) {
  const {
    id,
    url,
    title,
    uploader,
    description,
    duration,
    stage,
    progress,
    message,
    error,
    region,
    layout,
    createdAt,
    updatedAt,
    chapters,
    uploadDate,
    width,
    height,
    audio,
    slides,
    slidesVersion,
    params,
  } = job;
  return {
    id,
    url,
    title,
    uploader,
    description,
    duration,
    stage,
    progress,
    message,
    error,
    region,
    layout,
    createdAt,
    updatedAt,
    chapters,
    uploadDate,
    width,
    height,
    audio,
    slides,
    slidesVersion,
    params,
    running: running.has(id),
  };
}

/** Starts (or resumes) processing `url`. Resolves with the job once known. */
export async function createJob(url) {
  const info = JSON.parse(
    (
      await run('yt-dlp', ['-J', '--no-playlist', '--no-warnings', url])
    ).toString(),
  );
  const id = String(info.id)
    .replace(/[^\w-]/g, '_')
    .slice(0, 64);
  let job = await getJob(id);
  if (!job) {
    await mkdir(dir(id), { recursive: true });
    job = {
      id,
      url: info.webpage_url || url,
      title: info.title,
      uploader: info.uploader || info.channel,
      description: info.description,
      uploadDate: info.upload_date,
      duration: info.duration,
      chapters: (info.chapters || []).map(
        ({ start_time, end_time, title }) => ({
          start: start_time,
          end: end_time,
          title,
        }),
      ),
      createdAt: Date.now(),
      stage: 'queued',
      progress: 0,
      params: {},
    };
    jobs.set(id, job);
    await save(job);
  }
  if (job.stage !== 'ready') runPipeline(job);
  return job;
}

/** Re-runs slide detection with new parameters (and optionally a new region). */
export async function redetect(id, { params = {}, region } = {}) {
  const job = await getJob(id);
  if (!job || running.has(id)) return null;
  job.params = { ...job.params, ...params };
  if (region) job.region = { ...region, manual: true };
  job.stage = 'slides';
  runPipeline(job, { from: 'slides', newRegion: Boolean(region) });
  return job;
}

async function runPipeline(job, { from, newRegion } = {}) {
  if (running.has(job.id)) return;
  running.add(job.id);
  const d = dir(job.id);
  const video = join(d, 'video.mp4');
  try {
    if (!from && !existsSync(video)) {
      update(job, {
        stage: 'download',
        progress: 0,
        message: 'Downloading video',
        error: null,
      });
      await run(
        'yt-dlp',
        [
          '-f',
          'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b',
          '--merge-output-format',
          'mp4',
          '--no-playlist',
          '--newline',
          '-o',
          video,
          job.url,
        ],
        {
          onStdout: (s) => {
            const m = s.match(/\[download\]\s+([\d.]+)%/g);
            if (m) {
              const pct = parseFloat(m.at(-1).match(/([\d.]+)%/)[1]);
              update(job, { progress: pct / 100 });
            }
          },
        },
      );
    }
    if (!job.width) update(job, await probe(video));

    if (!from && !existsSync(join(d, 'audio.f32'))) {
      update(job, { stage: 'audio', progress: 0, message: 'Extracting audio' });
      const audio = await extractAudio(video, join(d, 'audio.f32'));
      update(job, { audio });
    }

    const layoutFile = join(d, 'layout.json');
    let layout = existsSync(layoutFile)
      ? JSON.parse(await readFile(layoutFile, 'utf8'))
      : null;
    if (!layout) {
      update(job, {
        stage: 'region',
        progress: 0,
        message: 'Working out the recording layout',
      });
      layout = await analyzeLayout(video, job);
      await writeFile(layoutFile, JSON.stringify(layout));
    }
    const { keyframes, ...layoutSummary } = layout;
    if (!job.region?.manual) job.region = layout.region;
    update(job, { layout: layoutSummary });
    // A fixed mix (or a region set by hand) crops before detection; otherwise
    // detection runs on the full frame and slides are cropped per window.
    const cropForDetection =
      job.region.manual || layout.layout === 'fixed' ? job.region : null;

    // Grayscale frames cropped to the region, cached for re-detection.
    update(job, {
      stage: 'slides',
      progress: 0,
      message: 'Detecting slide changes',
    });
    const framesFile = join(d, 'frames.gray');
    const regionKey = JSON.stringify([cropForDetection, SEG_W, SEG_H, SEG_FPS]);
    let frames;
    if (existsSync(framesFile) && job.framesRegion === regionKey) {
      const buf = await readFile(framesFile);
      frames = [];
      for (let o = 0; o + SEG_W * SEG_H <= buf.length; o += SEG_W * SEG_H) {
        frames.push(
          new Uint8Array(buf.buffer, buf.byteOffset + o, SEG_W * SEG_H),
        );
      }
    } else {
      frames = await readFrames(video, {
        fps: SEG_FPS,
        w: SEG_W,
        h: SEG_H,
        crop: cropForDetection?.full ? null : cropForDetection,
        duration: job.duration,
        onProgress: (p) => update(job, { progress: p }),
      });
      await writeFile(
        framesFile,
        Buffer.concat(
          frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.length)),
        ),
      );
      job.framesRegion = regionKey;
    }
    const { slides } = segmentSlides(frames, SEG_FPS, {
      ...job.params,
      width: SEG_W,
      maskLive: layout.layout !== 'fixed' && !job.region.manual,
    });
    scoreSlides(slides, layout);

    update(job, {
      stage: 'assets',
      progress: 0,
      message: `Rendering ${slides.length} slides`,
    });
    const slidesDir = join(d, 'slides');
    await rm(slidesDir, { recursive: true, force: true });
    await mkdir(slidesDir, { recursive: true });
    let done = 0;
    await pool(slides, 4, async (s, i) => {
      await renderSlide(
        video,
        s.region ||
          (layout.layout === 'varying' && !job.region.manual
            ? null
            : job.region),
        s,
        i,
        slidesDir,
        d,
      );
      update(job, { progress: ++done / slides.length });
    });
    update(job, {
      stage: 'ready',
      progress: 1,
      message: null,
      slides,
      slidesVersion: Date.now(),
    });
    await save(job);
  } catch (err) {
    console.error(err);
    update(job, { stage: 'error', error: String(err.message || err) });
    await save(job);
  } finally {
    running.delete(job.id);
  }
}

async function renderSlide(video, region, s, i, slidesDir, d) {
  const n = String(i + 1).padStart(3, '0');
  s.id = n;
  const last = s.states.at(-1);
  // The still shows the final build state, or the middle of a motion-only slide.
  const t = last ? last.t : (s.motion[0].start + s.motion[0].end) / 2;
  s.image = `slides/${n}.jpg`;
  await stillFrame(video, t, join(slidesDir, `${n}.jpg`), region);
  if (s.states.length > 1) {
    s.build = `slides/${n}-build.webp`;
    const steps = await buildAnimation(
      video,
      s.states,
      join(slidesDir, n),
      region,
    );
    s.steps = steps.map((f) => `slides/${f}`);
  }
  const m = s.motion.toSorted((a, b) => b.end - b.start - (a.end - a.start))[0];
  if (m && m.end - m.start >= 2) {
    s.clip = `slides/${n}-motion.mp4`;
    s.clipWebp = `slides/${n}-motion.webp`;
    s.clipRange = [m.start, Math.min(m.end, m.start + 30)];
    await motionClip(
      video,
      m.start,
      m.end,
      join(slidesDir, `${n}-motion`),
      region,
      join(d, 'tmp', `m${n}`),
    );
  }
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

export async function saveResults(id, body) {
  const job = await getJob(id);
  if (!job) return false;
  await writeFile(join(dir(id), 'results.json'), body);
  return true;
}

export async function loadResults(id) {
  try {
    return await readFile(join(dir(id), 'results.json'), 'utf8');
  } catch {
    return null;
  }
}

export async function deleteJob(id) {
  if (!validId(id) || running.has(id)) return false;
  jobs.delete(id);
  await rm(dir(id), { recursive: true, force: true });
  return true;
}
