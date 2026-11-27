// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Small helpers around child processes: run a command to completion, or
// stream its stdout in fixed-size records (raw video frames, PCM samples).

import { spawn } from 'node:child_process';

// Homebrew tools (yt-dlp, ffmpeg, img2webp) live here on Apple silicon.
const PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(
  ':',
);
export const env = { ...process.env, PATH };

/**
 * Runs `cmd` with `args` and resolves with its stdout. `onStderr` receives
 * stderr lines as they arrive (yt-dlp and ffmpeg report progress there).
 */
export function run(cmd, args, { onStderr, onStdout, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd });
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => {
      out.push(d);
      onStdout?.(d.toString());
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      err = (err + s).slice(-8000);
      if (onStderr)
        for (const line of s.split(/[\r\n]+/)) line && onStderr(line);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited with ${code}: ${err.slice(-1500)}`));
    });
  });
}

/**
 * Spawns `cmd` and calls `onRecord(buffer, index)` for every complete record
 * of `recordSize` bytes on stdout. Resolves with the number of records.
 */
export function streamRecords(cmd, args, recordSize, onRecord) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env });
    let pending = Buffer.alloc(0);
    let index = 0;
    let err = '';
    child.stdout.on('data', (d) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      while (pending.length >= recordSize) {
        onRecord(pending.subarray(0, recordSize), index++);
        pending = pending.subarray(recordSize);
      }
      // Detach the remainder from the large chunk it was sliced from.
      pending = Buffer.from(pending);
    });
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(index)
        : reject(new Error(`${cmd} exited with ${code}: ${err}`)),
    );
  });
}
