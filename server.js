// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// A dependency-free HTTP server: the app from `public/`, the browser
// libraries from `node_modules/` under `/vendor/`, job media from `data/`,
// and a small JSON API that drives the media pipeline in `lib/jobs.js`.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import {
  DATA,
  createJob,
  deleteJob,
  getJob,
  listJobs,
  loadResults,
  publicJob,
  redetect,
  saveResults,
} from './lib/jobs.js';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || 'localhost';
const ROOT = new URL('.', import.meta.url).pathname;
const MOUNTS = {
  '/vendor/': join(ROOT, 'node_modules'),
  '/data/': DATA.replace(/\/$/, ''),
  '/': join(ROOT, 'public'),
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.f32': 'application/octet-stream',
  '.map': 'application/json',
};

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': TYPES['.json'],
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

async function readBody(req, limit = 50e6) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString();
}

async function api(req, res, path) {
  const parts = path.split('/').filter(Boolean).slice(1); // drop "api"
  if (parts[0] !== 'jobs') return json(res, 404, { error: 'Not found' });
  const id = parts[1];
  if (!id) {
    if (req.method === 'GET') return json(res, 200, await listJobs());
    if (req.method === 'POST') {
      const { url } = JSON.parse(await readBody(req));
      if (!/^https?:\/\//.test(url || ''))
        return json(res, 400, { error: 'Give an http(s) URL.' });
      try {
        return json(res, 200, publicJob(await createJob(url)));
      } catch (err) {
        return json(res, 500, { error: String(err.message || err) });
      }
    }
  }
  const job = await getJob(id);
  if (!job) return json(res, 404, { error: 'No such job' });
  if (!parts[2]) {
    if (req.method === 'GET') return json(res, 200, publicJob(job));
    if (req.method === 'DELETE')
      return json(res, (await deleteJob(id)) ? 200 : 409, {});
  }
  if (parts[2] === 'results') {
    if (req.method === 'GET') {
      const r = await loadResults(id);
      res.writeHead(200, {
        'content-type': TYPES['.json'],
        'cache-control': 'no-store',
      });
      return res.end(r ?? '{}');
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      JSON.parse(body); // validate
      return json(res, (await saveResults(id, body)) ? 200 : 404, {});
    }
  }
  if (parts[2] === 'redetect' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const j = await redetect(id, body);
    return j
      ? json(res, 200, publicJob(j))
      : json(res, 409, { error: 'Job is busy' });
  }
  json(res, 404, { error: 'Not found' });
}

async function serveFile(req, res, path) {
  const mount = Object.keys(MOUNTS).find((m) => path.startsWith(m));
  const base = MOUNTS[mount];
  let file = normalize(
    join(base, decodeURIComponent(path.slice(mount.length))),
  );
  if (file !== base && !file.startsWith(base + sep)) {
    res.writeHead(403).end();
    return;
  }
  let st;
  try {
    st = await stat(file);
    if (st.isDirectory()) {
      file = join(file, 'index.html');
      st = await stat(file);
    }
  } catch {
    res.writeHead(404).end('Not found');
    return;
  }
  const headers = {
    'content-type': TYPES[extname(file)] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': mount === '/' ? 'no-cache' : 'no-cache',
  };
  // Range requests, so the video can seek.
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? +range[1] : st.size - +range[2];
    const end =
      range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      'content-length': end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname.startsWith('/api/')) await api(req, res, pathname);
    else await serveFile(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
    else res.end();
  }
}).listen(PORT, HOST, () => {
  console.log(`Slides Extractor on http://${HOST}:${PORT}/`);
});
