# Slides Extractor

Turns a recorded conference talk into a blog post you can read in place of
watching the video, with the slides extracted from the recording. Animated
slides keep their animation: build steps become an animated WebP (and
step-by-step fragments in the slide deck), and motion such as videos and live
demos becomes a short muted clip.

The split of work:

- **Node.js server** (no dependencies besides the browser libraries it serves):
  downloads the video with `yt-dlp`, extracts the audio, works out where the
  slides are in the frame, detects slide changes, and renders slide images and
  animations with `ffmpeg` and `img2webp`.
- **Browser** (Transformers.js on WebGPU, models cached through
  [Cross-Origin Storage](https://github.com/WICG/cross-origin-storage) when
  available):
  - Whisper large-v3 turbo transcribes the talk, with timestamps.
  - Gemma 4 (E2B or E4B) reads every slide (is it a slide, its title and text),
    then rewrites the transcript section by section into blog prose, using the
    slide text to fix misheard terms, and writes the title, summary, and
    takeaways. Gemma 4's audio encoder can also transcribe, if you'd rather
    download one model.

## Requirements

- Node.js 22 or later
- `yt-dlp`, `ffmpeg`, and `img2webp`: `brew install yt-dlp ffmpeg webp`
- A browser with WebGPU. For Cross-Origin Storage, the
  [COS extension](https://goo.gle/cos-extension) or a browser that ships it.

## Usage

```sh
npm install
npm start
```

Open http://localhost:8787/, paste a video URL, and press **Do it all** once the
media step finishes. Each step can also run on its own, and results are saved on
the server (`data/<video id>/results.json`), so a reload resumes.

Downloads:

- **Post (HTML)**: one self-contained file, images inlined.
- **Post (Markdown + images, ZIP)**: `index.md`, `index.html`, and the slide
  assets. Markdown uses animated WebP where the page uses video.
- **Slides (HTML deck)**: one self-contained file. Arrow keys or click to
  advance (build steps advance like fragments), `N` for speaker notes (the
  post's prose), `O` for an overview, `F` for full screen. Every slide has its
  own URL (`#12`).

**Open post in new tab** opens the post on its own page at
`read.html?v=<video id>`, and **Present slides** opens the deck at
`present.html?v=<video id>`, both served from the local files.

## Slide detection

Recordings come in different layouts, so detection first decides on a strategy
per video (`lib/detect.js`, `analyzeLayout()`):

- **Fixed mix**: slides next to the speaker (split view, speaker circle, picture
  in picture). Per pixel, it measures how often the value changes between
  keyframes: the speaker changes constantly, overlays never, slides in
  occasional steps. The largest rectangle of "occasional step" pixels, snapped
  to the slide's border in the time-averaged frame, is the slide region. The
  region is found again in separate time windows; if they agree, the layout is
  fixed. Frames whose static overlay doesn't match (a cut to a full-screen
  sponsor card or camera) are flagged.
- **Full screen**: the slides fill the frame. Frames with little flat area
  (camera footage) are flagged as camera shots.
- **Varying**: the windows disagree (the mix changes, or the camera follows the
  speaker); each stretch gets its own region.

Within the region, frames at 2 fps are split into stable states, and states are
grouped into slides (`segmentSlides()`):

- A **build step** adds content on the background: the changed pixels were
  background before.
- A **demo step** is a small change between states that flick by (a tooltip, a
  scroll). Code slides that swap a few lines change as few pixels, but stay up
  much longer.
- Anything else is a **new slide**. Stretches of continuous change are
  **motion** (videos, demos), rendered as clips. Very short slides are
  cross-fade frames and are dropped.

Gemma 4 makes the final call on what is a slide; you can untick slides in the
review grid, and change the sensitivity and detect again.

To tune detection on a downloaded video:

```sh
node lib/cli.js data/<id>/video.mp4         # slides
node lib/cli.js data/<id>/video.mp4 layout  # per-keyframe layout evidence
DEBUG_DETECT=1 node lib/cli.js data/<id>/video.mp4  # every boundary decision
```

## Keeping libraries current

```sh
ncu -u && npm install
```

## License

Apache-2.0
