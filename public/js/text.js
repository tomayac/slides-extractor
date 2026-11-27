// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Text plumbing: cleaning disfluencies from the transcript, assigning
// transcript chunks to slides, grouping slides into post sections, the
// prompts for Gemma 4, and a small Markdown renderer for the post.

/* Disfluencies */

// Fillers that are never content. "like", "so", and "right" often are, so
// those are left to the model.
const FILLERS =
  /(^|[\s,.;!?])(u+m+|u+h+m*|e+r+m+|e+h+|a+h+|h+m+|m+h*m+)(?=[\s,.;!?]|$)[,.]?/gi;
const STUTTER = /\b(\w+)(?:[\s,]+\1\b)+/gi; // "the the", "I, I"
const PHRASES = /(^|[\s,])(you know,|I mean,|sort of,|kind of,)(?=\s)/gi;

/** Removes "um"s, stutters, and similar noise; keeps meaning untouched. */
export function cleanDisfluencies(text) {
  return text
    .replace(FILLERS, '$1')
    .replace(PHRASES, '$1')
    .replace(STUTTER, '$1')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/([,.;!?])[,]+/g, '$1')
    .replace(/(^|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase())
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* Alignment */

/**
 * Builds post sections from slides and transcript chunks. Each chunk goes to
 * the slide on screen at its midpoint; speech during excluded slides (camera
 * shots) goes to the slide before. Slides with little speech join the next
 * section, so a run of quick slides reads as one passage.
 */
export function buildSections(
  slides,
  chunks,
  included,
  { minWords = 45 } = {},
) {
  const kept = slides.filter((s) => included(s));
  if (!kept.length) {
    return [
      {
        slides: [],
        start: 0,
        end: chunks.at(-1)?.end ?? 0,
        text: chunks.map((c) => c.text).join(' '),
      },
    ];
  }
  const groups = kept.map((s) => ({ slides: [s], start: s.start, chunks: [] }));
  for (const c of chunks) {
    const mid = (c.start + c.end) / 2;
    let g = groups.findLastIndex((x) => x.start <= mid);
    if (g < 0) g = 0;
    groups[g].chunks.push(c);
  }
  const words = (g) =>
    g.chunks.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
  const merged = [];
  let carry = null;
  for (const g of groups) {
    if (carry) {
      g.slides = [...carry.slides, ...g.slides];
      g.chunks = [...carry.chunks, ...g.chunks];
      g.start = carry.start;
      carry = null;
    }
    if (words(g) < minWords && g !== groups.at(-1)) carry = g;
    else merged.push(g);
  }
  // A short tail joins the last section.
  if (merged.length > 1 && words(merged.at(-1)) < minWords / 2) {
    const tail = merged.pop();
    merged.at(-1).slides.push(...tail.slides);
    merged.at(-1).chunks.push(...tail.chunks);
  }
  return merged.map((g, i) => ({
    slides: g.slides,
    start: g.start,
    end: merged[i + 1]?.start ?? g.chunks.at(-1)?.end ?? g.start,
    text: cleanDisfluencies(g.chunks.map((c) => c.text).join(' ')),
  }));
}

/* Prompts */

export const SLIDE_SYSTEM =
  'You look at frames from recorded conference talks and describe what is on them. You answer with JSON only.';

export function slidePrompt() {
  return [
    'This frame comes from a recorded conference talk, cropped to where the slides are shown.',
    'Reply with a JSON object with these keys:',
    '"type": one of "slide" (a presentation slide), "demo" (a browser, app, or code editor being shown), "video" (a video or animation playing), "camera" (people or the stage, no slide), "other" (sponsor or title card, blank screen).',
    '"title": the slide title, verbatim, or a 3 to 6 word label if there is none.',
    '"text": the other readable text on the frame, verbatim, at most 60 words (stop early on long lists or code).',
    '"visual": one short sentence describing pictures, diagrams, or code on it.',
  ].join('\n');
}

/**
 * Parses the first JSON object in `s`, tolerating code fences, chatter, and
 * output cut off by the token limit (then it salvages the string fields).
 */
export function parseJSON(s) {
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    for (const candidate of [
      m[0],
      m[0].replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"'),
    ]) {
      try {
        return JSON.parse(candidate);
      } catch {}
    }
  }
  const out = {};
  for (const f of s.matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g)) {
    try {
      out[f[1]] = JSON.parse(`"${f[2]}"`);
    } catch {
      out[f[1]] = f[2];
    }
  }
  return Object.keys(out).length ? out : null;
}

export const WRITE_SYSTEM =
  'You are an editor who turns transcripts of conference talks into polished blog posts. ' +
  "You write in the speaker's own voice (first person), keep everything they said that carries meaning, and never invent facts.";

export function sectionPrompt({
  talk,
  speaker,
  section,
  slideInfo,
  previous,
  index,
  total,
}) {
  const slideLines = section.slides
    .map((s) => slideInfo[s.id])
    .filter(Boolean)
    .map((i) => `- ${[i.title, i.text, i.visual].filter(Boolean).join(' | ')}`)
    .join('\n');
  return [
    `Talk: "${talk}"${speaker ? ` by ${speaker}` : ''}. This is part ${index + 1} of ${total}.`,
    slideLines ? `Slides shown during this part:\n${slideLines}` : '',
    previous ? `The previous part of the post ended with:\n"${previous}"` : '',
    `Transcript of this part (speech recognition, may contain errors):\n"""\n${section.text}\n"""`,
    'Rewrite this part of the talk as a section of a blog post.',
    '- First line: "## " followed by a short, specific heading for this section (use the slide title if it fits).',
    '- Then the prose, in Markdown paragraphs. Use a bullet list or `inline code` where the speaker enumerates things or names code.',
    '- Keep every point, example, number, and name. Drop filler, false starts, repetitions, and remarks about the talk itself ("can everyone hear me", "next slide").',
    '- Use the slide text to correct misheard names and technical terms.',
    '- Do not add anything the speaker did not say. Do not summarize the whole talk. No closing remarks.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function framePrompt({ talk, speaker, outline }) {
  return [
    `Talk: "${talk}"${speaker ? ` by ${speaker}` : ''}.`,
    `Here are the section headings of a blog post written from this talk, each with its opening:\n${outline}`,
    'Reply with a JSON object with these keys:',
    '"title": a blog post title for the talk (not just the talk title copied, unless it is good).',
    '"summary": two or three sentences saying what the talk is about and what readers learn.',
    '"takeaways": an array of 3 to 5 short key takeaways.',
  ].join('\n\n');
}

/** Splits model output into a heading and Markdown body. */
export function splitHeading(md) {
  const lines = md.trim().split('\n');
  let heading = '';
  if (/^#{1,4}\s+/.test(lines[0]))
    heading = lines
      .shift()
      .replace(/^#{1,4}\s+/, '')
      .trim();
  return { heading, body: lines.join('\n').trim() };
}

/* Markdown */

const escapeHTML = (s) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (m, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = escapeHTML(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s.replace(
    /\u0000(\d+)\u0000/g,
    (m, i) => `<code>${escapeHTML(codes[i])}</code>`,
  );
}

/** Renders the small Markdown subset the model writes. */
export function markdownToHTML(md) {
  const out = [];
  let list = null;
  let para = [];
  let fence = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
    if (list)
      out.push(
        `<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`,
      );
    list = null;
  };
  for (const line of md.split('\n')) {
    if (fence) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escapeHTML(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      flush();
      fence = [];
      continue;
    }
    const h = line.match(/^(#{2,4})\s+(.*)/);
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) {
      flush();
      out.push(`<h3>${inline(h[2])}</h3>`);
    } else if (ul || ol) {
      if (para.length) flush();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flush();
      list ??= { tag, items: [] };
      list.items.push((ul || ol)[1]);
    } else if (!line.trim()) {
      flush();
    } else if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  if (fence)
    out.push(`<pre><code>${escapeHTML(fence.join('\n'))}</code></pre>`);
  flush();
  return out.join('\n');
}

export { escapeHTML };

export const formatTime = (t) => {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
