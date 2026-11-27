// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Rendering the post, and the downloads: a self-contained post page, a ZIP
// of Markdown plus images, and a self-contained slide deck.

import { escapeHTML, formatTime, markdownToHTML } from './text.js';

/**
 * Whether slide `s` goes into the post and the deck. Two opinions count: the
 * detector's (does the frame fit the layout, does it look like a slide) and
 * Gemma's. A slide drops out when both say it isn't one, or when Gemma sees
 * a camera shot. A choice made in the review grid wins.
 */
export function isIncluded(s, results) {
  if (results.include && s.id in results.include) return results.include[s.id];
  const detectorSays = s.kind === 'slide' || s.kind === 'maybe';
  const type = results.slideInfo?.[s.id]?.type;
  if (!type) return detectorSays;
  if (type === 'camera') return false;
  return detectorSays || ['slide', 'demo', 'video'].includes(type);
}

/** A link to the original recording at second `t`. */
export function videoLink(url, t) {
  try {
    const u = new URL(url);
    u.searchParams.delete('list');
    u.searchParams.delete('index');
    u.searchParams.set('t', `${Math.floor(t)}s`);
    return u.href;
  } catch {
    return url;
  }
}

/** Which asset shows slide `s` for an animation mode. */
export function slideMedia(s, anim) {
  if (anim === 'static') return { type: 'img', src: s.image };
  if (anim === 'webp')
    return { type: 'img', src: s.clipWebp || s.build || s.image };
  if (s.clip) return { type: 'video', src: s.clip, poster: s.image };
  if (s.build) return { type: 'img', src: s.build };
  return { type: 'img', src: s.image };
}

function figure(job, s, info, anim, asset) {
  const m = slideMedia(s, anim);
  const alt = escapeHTML(
    [info?.title, info?.text].filter(Boolean).join(' — ').slice(0, 300) ||
      `Slide ${+s.id}`,
  );
  const media =
    m.type === 'video'
      ? `<video src="${asset(m.src)}" poster="${asset(m.poster)}" autoplay muted loop playsinline aria-label="${alt}"></video>`
      : `<img src="${asset(m.src)}" alt="${alt}" loading="lazy">`;
  return `<figure>${media}<figcaption>Slide ${+s.id} · <a href="${escapeHTML(videoLink(job.url, s.start))}">${formatTime(s.start)}</a></figcaption></figure>`;
}

/**
 * The post as HTML (the inside of the `<article>`). `asset(path)` maps an
 * asset path to a URL; `state.sections[i].status` drives placeholders while
 * writing is in progress.
 */
export function renderPost(
  job,
  post,
  slideInfo,
  { anim = 'auto', asset = (p) => p } = {},
) {
  const parts = [];
  parts.push(`<h1>${escapeHTML(post.title || job.title)}</h1>`);
  const date = job.uploadDate
    ? `${job.uploadDate.slice(0, 4)}-${job.uploadDate.slice(4, 6)}-${job.uploadDate.slice(6, 8)}`
    : '';
  parts.push(
    `<p class="byline">${escapeHTML(job.title)}${job.uploader ? ` · ${escapeHTML(job.uploader)}` : ''}${date ? ` · ${date}` : ''} · <a href="${escapeHTML(job.url)}">Watch the recording</a> (${formatTime(job.duration || 0)})</p>`,
  );
  if (post.summary || post.takeaways?.length) {
    parts.push(
      `<div class="tldr">${post.summary ? `<p>${escapeHTML(post.summary)}</p>` : ''}${
        post.takeaways?.length
          ? `<ul>${post.takeaways.map((t) => `<li>${escapeHTML(t)}</li>`).join('')}</ul>`
          : ''
      }</div>`,
    );
  }
  const byId = Object.fromEntries(job.slides.map((s) => [s.id, s]));
  for (const sec of post.sections || []) {
    if (sec.heading)
      parts.push(
        `<h2 id="t${Math.floor(sec.start)}">${escapeHTML(sec.heading)}</h2>`,
      );
    // Several slides in one passage (a demo, quick builds) read better as a
    // compact gallery than as a column of near-identical screenshots.
    const figs = sec.slideIds
      .filter((id) => byId[id])
      .map((id) => figure(job, byId[id], slideInfo[id], anim, asset));
    if (figs.length > 2)
      parts.push(`<div class="gallery">${figs.join('')}</div>`);
    else parts.push(...figs);
    if (sec.body) {
      parts.push(
        `<div class="${sec.status === 'writing' ? 'streaming' : ''}">${markdownToHTML(sec.body)}</div>`,
      );
    } else if (sec.status !== 'done') {
      parts.push(
        `<p class="pending">${sec.status === 'writing' ? 'Writing…' : 'Waiting to be written.'}</p>`,
      );
    }
  }
  return parts.join('\n');
}

/** The post as Markdown, with assets referenced by `asset(path)`. */
export function postMarkdown(
  job,
  post,
  slideInfo,
  { anim = 'auto', asset = (p) => p } = {},
) {
  const lines = [`# ${post.title || job.title}`, ''];
  lines.push(
    `*${job.title}${job.uploader ? ` · ${job.uploader}` : ''} · [Watch the recording](${job.url})*`,
    '',
  );
  if (post.summary) lines.push(`> ${post.summary}`, '');
  if (post.takeaways?.length)
    lines.push(...post.takeaways.map((t) => `- ${t}`), '');
  const byId = Object.fromEntries(job.slides.map((s) => [s.id, s]));
  for (const sec of post.sections || []) {
    if (sec.heading) lines.push(`## ${sec.heading}`, '');
    for (const id of sec.slideIds) {
      const s = byId[id];
      if (!s) continue;
      // Markdown has no video; animated WebP plays everywhere images do.
      const m = slideMedia(s, anim === 'auto' ? 'webp' : anim);
      const alt = (slideInfo[id]?.title || `Slide ${+id}`).replace(
        /[[\]]/g,
        '',
      );
      lines.push(
        `![${alt}](${asset(m.src)})`,
        `*Slide ${+id} · [${formatTime(s.start)}](${videoLink(job.url, s.start)})*`,
        '',
      );
    }
    if (sec.body) lines.push(sec.body, '');
  }
  return lines.join('\n');
}

/* Asset inlining */

const dataURLs = new Map();
export async function toDataURL(url) {
  if (dataURLs.has(url)) return dataURLs.get(url);
  const blob = await (await fetch(url)).blob();
  const p = new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
  dataURLs.set(url, p);
  return p;
}

/** Collects every asset path that `render(asset)` references. */
async function inlineAssets(render, base) {
  const paths = new Set();
  render((p) => (paths.add(p), p));
  const map = {};
  await Promise.all(
    [...paths].map(async (p) => (map[p] = await toDataURL(base + p))),
  );
  return render((p) => map[p]);
}

export async function postPage(job, post, slideInfo, { anim, base, css }) {
  const body = await inlineAssets(
    (asset) => renderPost(job, post, slideInfo, { anim, asset }),
    base,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHTML(post.title || job.title)}</title>
<style>${css}
body { padding: 16px; }
</style>
</head>
<body>
<article class="post">
${body}
</article>
</body>
</html>`;
}

/* ZIP (stored, no compression: the images are compressed already) */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a ZIP from `[{ name, data: Uint8Array | string }]`. */
export function zip(files) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate =
    ((now.getFullYear() - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // UTF-8 names
    head.setUint16(10, dosTime, true);
    head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true);
    local.push(new Uint8Array(head.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...local, ...central, new Uint8Array(end.buffer)], {
    type: 'application/zip',
  });
}

export async function markdownZip(job, post, slideInfo, { anim, base, css }) {
  const paths = new Set();
  const md = postMarkdown(job, post, slideInfo, {
    anim,
    asset: (p) => (paths.add(p), p),
  });
  const files = [{ name: 'index.md', data: md }];
  for (const p of paths) {
    files.push({
      name: p,
      data: new Uint8Array(await (await fetch(base + p)).arrayBuffer()),
    });
  }
  // A plain HTML version that uses the same image files.
  const html = renderPost(job, post, slideInfo, { anim });
  files.push({
    name: 'index.html',
    data: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHTML(post.title || job.title)}</title><style>${css} body{padding:16px}</style></head><body><article class="post">${html}</article></body></html>`,
  });
  for (const s of job.slides) {
    if (s.clip && html.includes(s.clip) && !paths.has(s.clip)) {
      files.push({
        name: s.clip,
        data: new Uint8Array(await (await fetch(base + s.clip)).arrayBuffer()),
      });
    }
    if (
      html.includes(s.image) &&
      !paths.has(s.image) &&
      !files.some((f) => f.name === s.image)
    ) {
      files.push({
        name: s.image,
        data: new Uint8Array(await (await fetch(base + s.image)).arrayBuffer()),
      });
    }
  }
  return zip(files);
}

/* Slide deck */

/**
 * A self-contained HTML deck. Build steps are separate images that advance
 * like fragments; motion plays as a muted looping video. Speaker notes are
 * the post's prose for that slide's section.
 */
export async function deckPage(
  job,
  post,
  slideInfo,
  slides,
  { base, inline = true, anim = 'auto' },
) {
  const sectionOf = {};
  for (const sec of post?.sections || []) {
    sec.slideIds.forEach((id, i) => (sectionOf[id] = { sec, first: i === 0 }));
  }
  const asset = inline ? null : (p) => base + p;
  const urls = {};
  const need = new Set();
  for (const s of slides) {
    need.add(s.image);
    if (anim !== 'static') {
      s.steps?.forEach((p) => need.add(p));
      if (s.clip) need.add(anim === 'webp' ? s.clipWebp : s.clip);
    }
  }
  await Promise.all(
    [...need].map(
      async (p) => (urls[p] = asset ? asset(p) : await toDataURL(base + p)),
    ),
  );
  const data = slides.map((s) => {
    const info = slideInfo[s.id] || {};
    const sec = sectionOf[s.id];
    return {
      id: s.id,
      title: info.title || '',
      t: s.start,
      steps:
        anim !== 'static' && s.steps?.length
          ? s.steps.map((p) => urls[p])
          : [urls[s.image]],
      clip:
        anim !== 'static' && s.clip
          ? urls[anim === 'webp' ? s.clipWebp : s.clip]
          : null,
      clipIsImage: anim === 'webp',
      notes: sec?.first
        ? `${sec.sec.heading ? `## ${sec.sec.heading}\n\n` : ''}${sec.sec.body || ''}`
        : '',
    };
  });
  const title = post?.title || job.title;
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<!-- Slides extracted from ${escapeHTML(job.url)} -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>
:root { --accent: #ff7a3d; color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #0d0e10; color: #eee; font: 16px/1.4 system-ui, sans-serif; overflow: hidden; }
.stage { position: fixed; inset: 0; display: grid; place-items: center; }
.slide { position: absolute; inset: 0; display: none; place-items: center; padding: 2vmin; }
.slide.active { display: grid; }
.frame { position: relative; width: min(96vw, calc(96vh * var(--ar))); aspect-ratio: var(--ar); }
.frame img, .frame video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.frame .step { opacity: 0; }
.frame .step.shown { opacity: 1; }
.bar { position: fixed; left: 0; bottom: 0; height: 3px; background: var(--accent); transition: width .2s; }
.num { position: fixed; right: 12px; bottom: 8px; font-size: 13px; opacity: .6; font-variant-numeric: tabular-nums; }
.notes { position: fixed; left: 0; right: 0; bottom: 0; max-height: 38vh; overflow: auto; background: rgb(20 21 24 / .94); padding: 16px 24px 24px; font-size: 18px; line-height: 1.5; display: none; border-top: 1px solid #333; }
body.show-notes .notes { display: block; }
.notes h2 { font-size: 20px; margin: 0 0 .5em; }
.help { position: fixed; top: 10px; right: 12px; font-size: 13px; opacity: 0; transition: opacity .3s; background: #222; padding: 8px 12px; border-radius: 8px; }
body.hint .help { opacity: .9; }
.overview { position: fixed; inset: 0; overflow: auto; display: none; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; padding: 20px; background: #0d0e10; }
body.show-overview .overview { display: grid; }
.overview button { all: unset; cursor: pointer; display: block; border-radius: 6px; overflow: hidden; outline: 2px solid transparent; }
.overview button.current { outline-color: var(--accent); }
.overview img { display: block; width: 100%; aspect-ratio: var(--ar); object-fit: contain; background: #000; }
.overview span { display: block; font-size: 12px; padding: 4px 2px; opacity: .8; }
</style>
</head>
<body class="hint">
<div class="stage" id="stage"></div>
<div class="bar" id="bar"></div>
<div class="num" id="num"></div>
<div class="notes" id="notes"></div>
<div class="overview" id="overview"></div>
<div class="help">← → navigate · N notes · O overview · F full screen</div>
<script type="application/json" id="data">${json}</script>
<script>
const slides = JSON.parse(document.getElementById('data').textContent);
const ar = ${(job.region?.w && job.region?.h ? job.region.w / job.region.h : 16 / 9).toFixed(4)};
document.documentElement.style.setProperty('--ar', ar);
const stage = document.getElementById('stage');
const overview = document.getElementById('overview');
const els = slides.map((s, i) => {
  const el = document.createElement('section');
  el.className = 'slide';
  const frame = document.createElement('div');
  frame.className = 'frame';
  s.steps.forEach((src, k) => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = s.title || 'Slide ' + (i + 1);
    img.className = 'step' + (k === 0 ? ' shown' : '');
    frame.append(img);
  });
  if (s.clip) {
    const v = document.createElement(s.clipIsImage ? 'img' : 'video');
    v.src = s.clip;
    if (!s.clipIsImage) { v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'none'; }
    v.className = 'clip step';
    frame.append(v);
  }
  el.append(frame);
  stage.append(el);
  const b = document.createElement('button');
  b.innerHTML = '<img loading="lazy" alt=""><span></span>';
  b.querySelector('img').src = s.steps.at(-1);
  b.querySelector('span').textContent = (i + 1) + '. ' + (s.title || '');
  b.onclick = () => { go(i, 0); document.body.classList.remove('show-overview'); };
  overview.append(b);
  return el;
});
// Steps per slide: build states, then the clip (if any) as the last step.
const count = (i) => slides[i].steps.length + (slides[i].clip ? 1 : 0);
let cur = 0, step = 0;
function render() {
  els.forEach((el, i) => {
    el.classList.toggle('active', i === cur);
    const steps = el.querySelectorAll('.step');
    steps.forEach((s, k) => s.classList.toggle('shown', i === cur ? k <= step : k === 0));
    const v = el.querySelector('video');
    if (v) {
      if (i === cur && step === steps.length - 1) { v.preload = 'auto'; v.play().catch(() => {}); }
      else v.pause();
    }
  });
  overview.querySelectorAll('button').forEach((b, i) => b.classList.toggle('current', i === cur));
  document.getElementById('bar').style.width = ((cur + 1) / slides.length * 100) + '%';
  document.getElementById('num').textContent = (cur + 1) + ' / ' + slides.length;
  const n = slides[cur].notes;
  document.getElementById('notes').innerHTML = n ? n.split(/\\n\\n+/).map((p) => p.startsWith('## ') ? '<h2>' + esc(p.slice(3)) + '</h2>' : '<p>' + esc(p) + '</p>').join('') : '<p style="opacity:.6">No notes for this slide.</p>';
  history.replaceState(null, '', '#' + (cur + 1));
}
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
function go(i, s) { cur = Math.max(0, Math.min(slides.length - 1, i)); step = s === -1 ? count(cur) - 1 : s; render(); }
function next() { step + 1 < count(cur) ? (step++, render()) : cur + 1 < slides.length && go(cur + 1, 0); }
function prev() { step > 0 ? (step--, render()) : cur > 0 && go(cur - 1, -1); }
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(k)) next();
  else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) prev();
  else if (k === 'Home') go(0, 0);
  else if (k === 'End') go(slides.length - 1, -1);
  else if (k === 'n' || k === 'N') document.body.classList.toggle('show-notes');
  else if (k === 'o' || k === 'O' || k === 'Escape') document.body.classList.toggle('show-overview', k !== 'Escape' && !document.body.classList.contains('show-overview'));
  else if (k === 'f' || k === 'F') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  else return;
  e.preventDefault();
});
stage.addEventListener('click', (e) => (e.clientX > innerWidth / 3 ? next() : prev()));
let touchX = null;
addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true });
addEventListener('touchend', (e) => { if (touchX === null) return; const dx = e.changedTouches[0].clientX - touchX; if (Math.abs(dx) > 40) dx < 0 ? next() : prev(); touchX = null; });
addEventListener('hashchange', () => { const n = parseInt(location.hash.slice(1)); if (n && n - 1 !== cur) go(n - 1, 0); });
setTimeout(() => document.body.classList.remove('hint'), 4000);
go((parseInt(location.hash.slice(1)) || 1) - 1, 0);
</script>
</body>
</html>`;
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
