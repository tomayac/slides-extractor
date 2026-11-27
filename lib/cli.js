// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Runs layout analysis and slide detection on a local video, for tuning:
// node lib/cli.js data/<id>/video.mp4

import {
  analyzeLayout,
  readFrames,
  scoreSlides,
  segmentSlides,
} from './detect.js';
import { probe } from './media.js';

const video = process.argv[2];
const info = await probe(video);
console.log(info);
let t = performance.now();
const layout = await analyzeLayout(video, info);
const { keyframes, ...summary } = layout;
console.log(
  JSON.stringify(summary),
  `${keyframes.length} keyframes`,
  `${((performance.now() - t) / 1000).toFixed(1)}s`,
);
if (process.argv[3] === 'layout') {
  for (const k of keyframes)
    console.log(k.t.toFixed(1).padStart(7), k.match, k.flat);
  process.exit();
}
t = performance.now();
const fps = 2;
const crop = layout.layout === 'fixed' ? layout.region : null;
const frames = await readFrames(video, { fps, w: 256, h: 144, crop });
const { slides, stableCount } = segmentSlides(frames, fps, {
  width: 256,
  maskLive: layout.layout !== 'fixed',
});
scoreSlides(slides, layout);
console.log(
  `${frames.length} frames, ${stableCount} states, ${slides.length} slides, ${((performance.now() - t) / 1000).toFixed(1)}s`,
);
for (const s of slides) {
  console.log(
    s.start.toFixed(1).padStart(7),
    s.end.toFixed(1).padStart(7),
    s.kind.padEnd(6),
    `match:${s.match?.toFixed(2)} flat:${s.flat?.toFixed(2)}`,
    `states:${s.states.length}`,
    s.motion.length
      ? `motion:${s.motion.map((m) => `${m.start}-${m.end}`).join(',')}`
      : '',
  );
}
