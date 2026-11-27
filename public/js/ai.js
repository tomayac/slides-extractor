// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Local models through Transformers.js on WebGPU: Whisper for timestamped
// speech recognition, and Gemma 4 for reading slides, transcribing (as an
// alternative), and writing. Model files go through Cross-Origin Storage
// when the browser has it, so a model downloaded by any site is reused here.

import {
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  InterruptableStoppingCriteria,
  RawImage,
  TextStreamer,
  env,
  pipeline,
} from '@huggingface/transformers';

env.experimental_useCrossOriginStorage = true;

export const hasCOS = () => 'crossOriginStorage' in navigator;
export const hasWebGPU = () => 'gpu' in navigator;

let f16Support;
async function supportsF16() {
  if (f16Support !== undefined) return f16Support;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    f16Support = Boolean(adapter?.features.has('shader-f16'));
  } catch {
    f16Support = false;
  }
  return f16Support;
}

/**
 * Turns Transformers.js' per-file progress events into one overall
 * fraction, by bytes across all files seen so far.
 */
function progressTracker(onProgress) {
  const files = new Map();
  return (info) => {
    if (info.status === 'progress_total' && typeof info.progress === 'number') {
      onProgress?.({
        loaded: info.loaded,
        total: info.total,
        fraction: info.progress / 100,
      });
      return;
    }
    if (info.status === 'progress' && info.total) {
      files.set(info.file, { loaded: info.loaded, total: info.total });
    } else if (info.status === 'done' && files.has(info.file)) {
      const f = files.get(info.file);
      f.loaded = f.total;
    } else return;
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) ((loaded += f.loaded), (total += f.total));
    onProgress?.({ loaded, total, fraction: total ? loaded / total : 0 });
  };
}

// Only one large model is kept in GPU memory at a time.
let current = null; // { key, dispose() }

async function release(exceptKey) {
  if (current && current.key !== exceptKey) {
    try {
      await current.dispose();
    } catch {}
    current = null;
  }
}

/* Whisper */

const WHISPER = {
  'whisper-large-v3-turbo': 'onnx-community/whisper-large-v3-turbo',
  'whisper-base': 'onnx-community/whisper-base',
};

let whisper = null;

export async function loadWhisper(kind, onProgress) {
  const key = `whisper:${kind}`;
  if (current?.key === key) return whisper;
  await release(key);
  const f16 = await supportsF16();
  whisper = await pipeline('automatic-speech-recognition', WHISPER[kind], {
    device: 'webgpu',
    dtype: {
      encoder_model: f16 ? 'fp16' : 'fp32',
      decoder_model_merged: 'q4',
    },
    progress_callback: progressTracker(onProgress),
  });
  current = { key, dispose: () => whisper.dispose() };
  return whisper;
}

/**
 * Transcribes one audio segment (at most 30 s of 16 kHz mono) with Whisper.
 * Returns chunks with absolute times.
 */
export async function whisperSegment(audio, offset, language) {
  const out = await whisper(audio, {
    language,
    task: 'transcribe',
    return_timestamps: true,
  });
  const chunks = out.chunks?.length
    ? out.chunks
    : [{ timestamp: [0, audio.length / 16000], text: out.text }];
  const dur = audio.length / 16000;
  return chunks
    .map((c) => ({
      start: +(offset + (c.timestamp[0] ?? 0)).toFixed(2),
      end: +(offset + (c.timestamp[1] ?? dur)).toFixed(2),
      text: c.text.trim(),
    }))
    .filter((c) => c.text);
}

/* Gemma 4 */

let gemma = null; // { processor, model, id }

export async function loadGemma(modelId, onProgress) {
  const key = `gemma:${modelId}`;
  if (current?.key === key) return gemma;
  await release(key);
  const track = progressTracker(onProgress);
  const processor = await AutoProcessor.from_pretrained(modelId, {
    progress_callback: track,
  });
  const model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
    dtype: 'q4f16',
    device: 'webgpu',
    progress_callback: track,
  });
  gemma = { processor, model, id: modelId };
  current = { key, dispose: () => model.dispose() };
  return gemma;
}

export async function unloadModels() {
  await release(null);
}

/**
 * Runs one Gemma 4 turn. `image` is a URL or RawImage, `audio` a 16 kHz
 * Float32Array. `onText` receives the growing output while it streams.
 */
export async function generate({
  system,
  prompt,
  image,
  audio,
  maxNewTokens = 1024,
  onText,
  imageTokens = 280,
  signal,
}) {
  const { processor, model } = gemma;
  const content = [];
  if (image) content.push({ type: 'image' });
  if (audio) content.push({ type: 'audio' });
  content.push({ type: 'text', text: prompt });
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });
  const text = processor.apply_chat_template(messages, {
    enable_thinking: false,
    add_generation_prompt: true,
  });
  let img = null;
  if (image) {
    img = typeof image === 'string' ? await RawImage.fromURL(image) : image;
    if (processor.image_processor)
      processor.image_processor.max_soft_tokens = imageTokens;
  }
  const inputs = await processor(text, img, audio ?? null, {
    add_special_tokens: false,
  });
  let output = '';
  const streamer = new TextStreamer(processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (t) => {
      output += t;
      onText?.(output);
    },
  });
  let stopping_criteria;
  if (signal) {
    const stop = new InterruptableStoppingCriteria();
    signal.addEventListener('abort', () => stop.interrupt(), { once: true });
    stopping_criteria = [stop];
  }
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens,
    do_sample: false,
    repetition_penalty: 1.05,
    streamer,
    ...(stopping_criteria ? { stopping_criteria } : {}),
  });
  const decoded = processor.batch_decode(
    outputs.slice(null, [inputs.input_ids.dims.at(-1), null]),
    {
      skip_special_tokens: true,
    },
  );
  return decoded[0].trim();
}

/** Transcribes a segment with Gemma 4's audio encoder (no timestamps). */
export async function gemmaSegment(audio, start, end, languageName) {
  const text = await generate({
    audio,
    maxNewTokens: 400,
    prompt:
      `Transcribe the following speech segment in ${languageName} into ${languageName} text.\n\n` +
      'Follow these specific instructions for formatting the answer:\n' +
      '* Only output the transcription, with no newlines.\n' +
      '* When transcribing numbers, write the digits, i.e. write 1.7 and not one point seven, and write 3 instead of three.',
  });
  return text ? [{ start, end, text: text.replace(/\s+/g, ' ').trim() }] : [];
}
