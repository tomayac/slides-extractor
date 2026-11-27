// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// The app: pick or start a job, follow the server's media pipeline, then run
// the model steps in the browser (transcribe, read slides, write), and show
// and export the result. Results are saved on the server after every step,
// so a reload resumes where it left off.

import {
  deckPage,
  download,
  isIncluded,
  markdownZip,
  postPage,
  renderPost,
} from './export.js';
import {
  SLIDE_SYSTEM,
  WRITE_SYSTEM,
  buildSections,
  escapeHTML,
  formatTime,
  framePrompt,
  parseJSON,
  sectionPrompt,
  slidePrompt,
  splitHeading,
} from './text.js';

const $ = (sel) => document.querySelector(sel);
const LANGUAGES = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  nl: 'Dutch',
  pt: 'Portuguese',
  ja: 'Japanese',
};

// Transformers.js is large; load it only when a model step runs.
let aiModule;
const ai = () => (aiModule ??= import('./ai.js'));

let job = null;
let results = null;
let busy = false;

/* Startup */

const params = new URLSearchParams(location.search);
$('#badge-webgpu').classList.add('gpu' in navigator ? 'on' : 'off');
$('#badge-cos').classList.add('crossOriginStorage' in navigator ? 'on' : 'off');
$('#badge-cos').title +=
  'crossOriginStorage' in navigator
    ? ' (available)'
    : ' (not available in this browser: models use the regular cache)';

$('#url-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = 'Starting…';
  $('#url-error').hidden = true;
  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ url: $('#url').value.trim() }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    location.search = `?v=${encodeURIComponent(j.id)}`;
  } catch (err) {
    $('#url-error').textContent = err.message;
    $('#url-error').hidden = false;
    btn.disabled = false;
    btn.textContent = 'Extract';
  }
});

if (params.get('v')) openJob(params.get('v'));
else listJobs();

async function listJobs() {
  const jobs = await (await fetch('/api/jobs')).json();
  $('#jobs').innerHTML = jobs
    .map(
      (j) => `<a class="job-card" href="?v=${encodeURIComponent(j.id)}">
        <img src="${j.slides?.length ? `/data/${j.id}/${(j.slides.find((s) => s.kind === 'slide') || j.slides[0]).image}` : ''}" alt="" loading="lazy">
        <span>${escapeHTML(j.title || j.id)}<br><span class="muted small" style="padding:0">${j.stage === 'ready' ? `${j.slides?.length ?? 0} slides` : j.stage}</span></span>
      </a>`,
    )
    .join('');
}

/* Job */

const base = () => `/data/${job.id}/`;
const asset = (p) => `${base()}${p}?v=${job.slidesVersion || ''}`;

async function openJob(id) {
  $('#start').hidden = true;
  $('#job').hidden = false;
  await refreshJob(id);
  results = await (await fetch(`/api/jobs/${id}/results`)).json();
  results.settings ??= {};
  results.slideInfo ??= {};
  results.include ??= {};
  for (const [key, el] of Object.entries(settingInputs())) {
    if (results.settings[key] !== undefined) el.value = results.settings[key];
    el.addEventListener('change', () => {
      results.settings[key] = el.value;
      save();
      if (key === 'anim') renderPostView();
    });
  }
  if (job.params?.newSlide) $('#set-sensitivity').value = job.params.newSlide;
  document.title = `${job.title} · Slides Extractor`;
  while (
    job.stage !== 'ready' &&
    job.stage !== 'error' &&
    job.stage !== 'interrupted'
  ) {
    await new Promise((r) => setTimeout(r, 1000));
    await refreshJob(id);
  }
  renderAll();
  if (params.has('auto')) runAll();
}

function settingInputs() {
  return {
    asr: $('#set-asr'),
    lang: $('#set-lang'),
    gemma: $('#set-gemma'),
    anim: $('#set-anim'),
  };
}

async function refreshJob(id) {
  job = await (await fetch(`/api/jobs/${id}`)).json();
  $('#job-title').textContent = job.title;
  $('#job-meta').innerHTML = [
    job.uploader && escapeHTML(job.uploader),
    job.duration && formatTime(job.duration),
    `<a href="${escapeHTML(job.url)}">${escapeHTML(new URL(job.url).host)}</a>`,
  ]
    .filter(Boolean)
    .join(' · ');
  const cover = job.slides?.find((s) => s.kind === 'slide') || job.slides?.[0];
  if (cover) $('#job-thumb').src = asset(cover.image);
  const step = $('#step-media');
  const labels = {
    queued: 'Queued',
    download: 'Downloading',
    audio: 'Extracting audio',
    region: 'Working out the layout',
    slides: 'Detecting slide changes',
    assets: 'Rendering slides',
    ready: 'Done',
    error: 'Failed',
    interrupted:
      'Interrupted (the server restarted). Start it again from the start page.',
  };
  setStep(step, {
    status: labels[job.stage] || job.stage,
    progress:
      job.stage === 'ready' || job.stage === 'error' ? null : job.progress,
    state:
      job.stage === 'ready' ? 'done' : job.stage === 'error' ? 'failed' : '',
    detail:
      job.stage === 'error'
        ? job.error
        : job.stage === 'ready'
          ? `${job.slides.length} slides · ${describeLayout()}`
          : job.message || '',
  });
}

function describeLayout() {
  const l = job.layout;
  if (!l) return '';
  const r = job.region;
  const names = {
    fixed: 'fixed camera mix, slides cropped from the frame',
    fullscreen: 'slides fill the frame',
    varying: 'the layout changes during the talk, cropped per stretch',
  };
  return `${names[l.layout] || l.layout}${r && !r.full ? ` (${r.w}×${r.h} at ${r.x},${r.y})` : ''}`;
}

function setStep(el, { status, progress, state, detail }) {
  if (status !== undefined)
    el.querySelector('.step-status').textContent = status;
  const bar = el.querySelector('progress');
  if (progress === null) bar.hidden = true;
  else if (progress !== undefined) {
    bar.hidden = false;
    bar.value = progress;
  }
  if (state !== undefined) {
    el.classList.toggle('done', state === 'done');
    el.classList.toggle('failed', state === 'failed');
  }
  if (detail !== undefined)
    el.querySelector('.step-detail').textContent = detail;
}

let saveTimer;
function save(now = false) {
  clearTimeout(saveTimer);
  const put = () =>
    fetch(`/api/jobs/${job.id}/results`, {
      method: 'PUT',
      body: JSON.stringify(results),
    });
  if (now) return put();
  saveTimer = setTimeout(put, 800);
}

/* Rendering */

function renderAll() {
  renderStepStates();
  renderSlides();
  renderTranscript();
  renderPostView();
}

function renderStepStates() {
  const t = results.transcript;
  const segs = job.audio?.segments?.length ?? 0;
  if (t?.chunks?.length) {
    const complete = t.done >= segs;
    setStep($('#step-asr'), {
      status: complete ? 'Done' : `${t.done} of ${segs} segments`,
      state: complete ? 'done' : '',
      detail: `${t.chunks.length} phrases · ${t.chunks.reduce((n, c) => n + c.text.split(/\s+/).length, 0)} words · ${t.model}`,
    });
  } else {
    setStep($('#step-asr'), {
      detail: `${segs} segments of up to 28 s, cut at pauses`,
    });
  }
  const analyzed = Object.keys(results.slideInfo).length;
  if (analyzed) {
    setStep($('#step-slides'), {
      status:
        analyzed >= job.slides.length
          ? 'Done'
          : `${analyzed} of ${job.slides.length}`,
      state: analyzed >= job.slides.length ? 'done' : '',
    });
  }
  const secs = results.post?.sections;
  if (secs?.length) {
    const done = secs.filter((s) => s.status === 'done').length;
    setStep($('#step-write'), {
      status:
        done === secs.length && results.post.summary
          ? 'Done'
          : `${done} of ${secs.length} sections`,
      state: done === secs.length && results.post.summary ? 'done' : '',
    });
  }
  for (const b of document.querySelectorAll('button.run')) {
    const label = {
      asr: 'Transcribe',
      slides: 'Read slides',
      write: 'Write post',
    }[b.dataset.step];
    b.textContent = isComplete(b.dataset.step) ? 'Redo' : label;
  }
  const ready = job.stage === 'ready';
  for (const b of document.querySelectorAll('button.run, #run-all'))
    b.disabled = busy || !ready;
  $('#redetect').disabled = busy;
  const hasPost = Boolean(secs?.some((s) => s.body));
  $('#export-html').disabled = !hasPost;
  $('#export-md').disabled = !hasPost;
  $('#export-deck').disabled = !ready;
  $('#open-deck').disabled = !ready;
  $('#open-post').disabled = !hasPost;
}

function isComplete(step) {
  if (step === 'asr')
    return (
      (results.transcript?.done ?? 0) >= (job.audio?.segments?.length ?? 1)
    );
  if (step === 'slides')
    return (
      Boolean(job.slides?.length) &&
      job.slides.every((s) => results.slideInfo[s.id])
    );
  if (step === 'write')
    return (
      Boolean(results.post?.summary) &&
      results.post.sections.every((s) => s.status === 'done')
    );
  return false;
}

const included = (s) => isIncluded(s, results);

function renderSlides() {
  if (!job.slides) return;
  const n = job.slides.filter(included).length;
  $('#slide-count').textContent = `${n} of ${job.slides.length} included`;
  $('#layout-info').textContent = job.layout
    ? `Layout: ${describeLayout()}.`
    : '';
  $('#slide-grid').innerHTML = job.slides
    .map((s) => {
      const info = results.slideInfo[s.id];
      const tags = [];
      if (info?.type && info.type !== 'slide')
        tags.push(`<span class="tag">${info.type}</span>`);
      else if (!info && s.kind !== 'slide')
        tags.push(
          `<span class="tag warn">${s.kind === 'other' ? 'off-layout' : s.kind}</span>`,
        );
      if (s.steps)
        tags.push(`<span class="tag">${s.steps.length} builds</span>`);
      if (s.clip) tags.push('<span class="tag">motion</span>');
      return `<div class="slide-tile ${included(s) ? '' : 'excluded'}" data-id="${s.id}">
        <img src="${asset(s.image)}" alt="" loading="lazy" data-t="${s.start}">
        <div class="tags">${tags.join('')}</div>
        <label class="meta"><input type="checkbox" ${included(s) ? 'checked' : ''}><span class="t" title="${escapeHTML(info?.title || '')}">${+s.id}. ${escapeHTML(info?.title || formatTime(s.start))}</span></label>
      </div>`;
    })
    .join('');
}

$('#slide-grid').addEventListener('change', (e) => {
  const tile = e.target.closest('.slide-tile');
  if (!tile) return;
  results.include[tile.dataset.id] = e.target.checked;
  tile.classList.toggle('excluded', !e.target.checked);
  $('#slide-count').textContent =
    `${job.slides.filter(included).length} of ${job.slides.length} included`;
  save();
});

$('#slide-grid').addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG') play(+e.target.dataset.t);
});

function play(t) {
  const v = $('#player');
  if (!v.src) v.src = `${base()}video.mp4`;
  v.hidden = false;
  $('#review').open = true;
  v.currentTime = t;
  v.play().catch(() => {});
  v.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderTranscript() {
  const chunks = results.transcript?.chunks || [];
  $('#transcript-count').textContent = chunks.length
    ? `${chunks.length} phrases`
    : '';
  $('#transcript').innerHTML = chunks
    .map(
      (c) =>
        `<p><time data-t="${c.start}">${formatTime(c.start)}</time>${escapeHTML(c.text)}</p>`,
    )
    .join('');
}

$('#transcript').addEventListener('click', (e) => {
  if (e.target.tagName === 'TIME') play(+e.target.dataset.t);
});

let renderQueued = false;
function renderPostView() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const post = results.post;
    $('#post').hidden = !post?.sections?.length;
    $('#post-tools').hidden = $('#post').hidden;
    $('#post-link').href = `read.html?v=${encodeURIComponent(job.id)}`;
    if (post?.sections?.length) {
      $('#post').innerHTML = renderPost(job, post, results.slideInfo, {
        anim: $('#set-anim').value,
        asset,
      });
    }
  });
}

/* Steps */

for (const b of document.querySelectorAll('button.run')) {
  // A finished step runs again from scratch; a partial one continues.
  b.addEventListener('click', () =>
    runStep(b.dataset.step, { resume: !isComplete(b.dataset.step) }),
  );
}

const runAllButton = document.createElement('button');
runAllButton.id = 'run-all';
runAllButton.textContent = 'Do it all';
runAllButton.disabled = true; // until the media step is done
$('.job-head > div').append(runAllButton);
runAllButton.addEventListener('click', runAll);

async function runAll() {
  for (const step of ['asr', 'slides', 'write']) {
    if (!(await runStep(step, { resume: true }))) return;
  }
}

async function runStep(step, { resume = false } = {}) {
  if (busy) return false;
  busy = true;
  renderStepStates();
  const el = $(`#step-${step}`);
  try {
    if (step === 'asr') await transcribe(el, resume);
    if (step === 'slides') await readSlides(el, resume);
    if (step === 'write') await write(el, resume);
    await save(true);
    return true;
  } catch (err) {
    console.error(err);
    setStep(el, {
      status: 'Failed',
      state: 'failed',
      detail: String(err.message || err),
      progress: null,
    });
    return false;
  } finally {
    busy = false;
    renderStepStates();
  }
}

function modelProgress(el, what) {
  return ({ loaded, total, fraction }) => {
    setStep(el, {
      status: `Loading ${what}`,
      progress: fraction,
      detail: total
        ? `${(loaded / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB${'crossOriginStorage' in navigator ? ' (through Cross-Origin Storage)' : ''}`
        : '',
    });
  };
}

let audioCache = null;
async function loadAudio() {
  if (audioCache?.id === job.id) return audioCache.samples;
  const buf = await (await fetch(`${base()}audio.f32`)).arrayBuffer();
  audioCache = { id: job.id, samples: new Float32Array(buf) };
  return audioCache.samples;
}

async function transcribe(el, resume) {
  const kind = $('#set-asr').value;
  const lang = $('#set-lang').value;
  const segments = job.audio.segments;
  let t = results.transcript;
  const model = kind === 'gemma' ? $('#set-gemma').value.split('/')[1] : kind;
  if (!resume || !t || t.model !== model || t.lang !== lang) {
    t = results.transcript = { model, lang, chunks: [], done: 0 };
  }
  if (t.done >= segments.length) return;
  setStep(el, { state: '', status: 'Loading audio', progress: 0 });
  const audio = await loadAudio();
  const m = await ai();
  if (kind === 'gemma')
    await m.loadGemma($('#set-gemma').value, modelProgress(el, 'Gemma 4'));
  else await m.loadWhisper(kind, modelProgress(el, 'Whisper'));
  const started = performance.now();
  const first = t.done;
  for (let i = t.done; i < segments.length; i++) {
    const { start, end } = segments[i];
    const pcm = audio.subarray(
      Math.floor(start * 16000),
      Math.floor(end * 16000),
    );
    const chunks =
      kind === 'gemma'
        ? await m.gemmaSegment(pcm, start, end, LANGUAGES[lang])
        : await m.whisperSegment(pcm, start, lang);
    t.chunks.push(...chunks);
    t.done = i + 1;
    const per = (performance.now() - started) / (i + 1 - first);
    setStep(el, {
      status: `Transcribing ${formatTime(end)} of ${formatTime(job.duration)}`,
      progress: (i + 1) / segments.length,
      detail: `${chunks
        .map((c) => c.text)
        .join(' ')
        .slice(
          0,
          160,
        )} · about ${formatTime((per * (segments.length - i - 1)) / 1000)} left`,
    });
    renderTranscript();
    save();
  }
  setStep(el, { progress: null });
}

async function readSlides(el, resume) {
  if (!resume) results.slideInfo = {};
  const todo = job.slides.filter((s) => !results.slideInfo[s.id]);
  if (!todo.length) return;
  const m = await ai();
  await m.loadGemma($('#set-gemma').value, modelProgress(el, 'Gemma 4'));
  let n = job.slides.length - todo.length;
  for (const s of todo) {
    setStep(el, {
      status: `Reading slide ${+s.id} of ${job.slides.length}`,
      progress: n / job.slides.length,
    });
    const out = await m.generate({
      system: SLIDE_SYSTEM,
      prompt: slidePrompt(),
      image: new URL(asset(s.image), location.href).href,
      maxNewTokens: 480,
    });
    const info = parseJSON(out) || {
      type: 'slide',
      title: '',
      text: out.slice(0, 400),
    };
    results.slideInfo[s.id] = {
      type: String(info.type || 'slide').toLowerCase(),
      title: String(info.title || '').trim(),
      text: String(info.text || '').trim(),
      visual: String(info.visual || '').trim(),
    };
    n++;
    setStep(el, {
      detail: `${+s.id}: ${results.slideInfo[s.id].type} · ${results.slideInfo[s.id].title}`,
    });
    renderSlides();
    save();
  }
  setStep(el, { progress: null });
}

async function write(el, resume) {
  const chunks = results.transcript?.chunks;
  if (!chunks?.length) throw new Error('Transcribe the talk first.');
  const sections = buildSections(job.slides, chunks, included);
  const old = results.post?.sections || [];
  const key = (s) => `${s.slideIds.join(',')}|${s.text.length}`;
  const prior = new Map(
    old.filter((s) => s.status === 'done').map((s) => [key(s), s]),
  );
  results.post = {
    ...(resume ? results.post : {}),
    sections: sections.map((s) => {
      const fresh = {
        slideIds: s.slides.map((x) => x.id),
        start: s.start,
        end: s.end,
        text: s.text,
        status: 'pending',
      };
      const was = resume && prior.get(key(fresh));
      return was || fresh;
    }),
  };
  if (!resume) {
    delete results.post.title;
    delete results.post.summary;
    delete results.post.takeaways;
  }
  renderPostView();
  const m = await ai();
  await m.loadGemma($('#set-gemma').value, modelProgress(el, 'Gemma 4'));
  const secs = results.post.sections;
  for (let i = 0; i < secs.length; i++) {
    const sec = secs[i];
    if (sec.status === 'done') continue;
    setStep(el, {
      status: `Writing section ${i + 1} of ${secs.length}`,
      progress: i / secs.length,
      detail: '',
    });
    sec.status = 'writing';
    const previous =
      secs[i - 1]?.body?.split('\n').filter(Boolean).at(-1)?.slice(-300) || '';
    const words = sec.text.split(/\s+/).length;
    const out = await m.generate({
      system: WRITE_SYSTEM,
      prompt: sectionPrompt({
        talk: job.title,
        speaker: job.uploader,
        section: { ...sec, slides: sec.slideIds.map((id) => ({ id })) },
        slideInfo: results.slideInfo,
        previous,
        index: i,
        total: secs.length,
      }),
      maxNewTokens: Math.min(1400, Math.round(words * 1.6) + 120),
      onText: (text) => {
        Object.assign(sec, splitHeading(text));
        renderPostView();
      },
    });
    Object.assign(sec, splitHeading(out), { status: 'done' });
    renderPostView();
    save();
  }
  if (!results.post.summary) {
    setStep(el, { status: 'Writing the introduction', progress: 0.98 });
    const outline = secs
      .map(
        (s, i) =>
          `${i + 1}. ${s.heading}: ${s.body.slice(0, 160).replace(/\s+/g, ' ')}…`,
      )
      .join('\n');
    const out = await m.generate({
      prompt: framePrompt({ talk: job.title, speaker: job.uploader, outline }),
      maxNewTokens: 400,
    });
    const f = parseJSON(out) || {};
    results.post.title = String(f.title || job.title);
    results.post.summary = String(f.summary || '');
    results.post.takeaways = Array.isArray(f.takeaways)
      ? f.takeaways.map(String)
      : [];
  }
  setStep(el, { progress: null });
  renderPostView();
}

/* Detection settings */

$('#redetect').addEventListener('click', async () => {
  const res = await fetch(`/api/jobs/${job.id}/redetect`, {
    method: 'POST',
    body: JSON.stringify({
      params: { newSlide: +$('#set-sensitivity').value },
    }),
  });
  if (!res.ok) return;
  // Slide ids change; analyses and the post no longer line up.
  results.slideInfo = {};
  results.include = {};
  if (results.post) results.post.sections = [];
  await save(true);
  location.reload();
});

/* Exports */

const fileBase = () =>
  (results.post?.title || job.title)
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 80) || job.id;
const css = () => fetch('/styles.css').then((r) => r.text());

async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing…';
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

$('#export-html').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const html = await postPage(job, results.post, results.slideInfo, {
      anim: $('#set-anim').value,
      base: base(),
      css: await css(),
    });
    download(new Blob([html], { type: 'text/html' }), `${fileBase()}.html`);
  }),
);

$('#export-md').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const blob = await markdownZip(job, results.post, results.slideInfo, {
      anim: $('#set-anim').value,
      base: base(),
      css: await css(),
    });
    download(blob, `${fileBase()}.zip`);
  }),
);

const deckSlides = () => job.slides.filter(included);

$('#export-deck').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const html = await deckPage(
      job,
      results.post,
      results.slideInfo,
      deckSlides(),
      { base: base(), anim: $('#set-anim').value },
    );
    download(
      new Blob([html], { type: 'text/html' }),
      `${fileBase()}-slides.html`,
    );
  }),
);

$('#open-post').addEventListener('click', async () => {
  await save(true);
  window.open(`read.html?v=${encodeURIComponent(job.id)}`, '_blank');
});

$('#open-deck').addEventListener('click', async () => {
  await save(true);
  window.open(`present.html?v=${encodeURIComponent(job.id)}`, '_blank');
});
