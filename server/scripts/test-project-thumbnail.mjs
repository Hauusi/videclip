#!/usr/bin/env node
/**
 * Standalone test: node server/scripts/test-project-thumbnail.mjs <video.mp4> [out.jpg]
 */
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { generateProjectThumbnail } from '../src/services/projectThumbnail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const video = process.argv[2];
const out = process.argv[3] || path.join(__dirname, '..', 'test-thumb.jpg');

if (!video) {
  console.error('Usage: node test-project-thumbnail.mjs <video.mp4> [out.jpg]');
  process.exit(1);
}

const workDir = path.join(path.dirname(out), '.thumb-test-work');
await fs.mkdir(workDir, { recursive: true });

const highlights = [
  {
    id: 'clip-1',
    title: 'HORRORTRIP mit den Jungs',
    start_time: 30,
    end_time: 75,
    hook_peak_time: 48,
    viral_score: 9,
  },
];

const result = await generateProjectThumbnail({
  jobId: 'test-job',
  workDir,
  sourceVideo: path.resolve(video),
  highlights,
  mood: 'hype',
  videoTitle: 'HORRORTRIP mit den Jungs',
});

if (!result?.path) {
  console.error('Thumbnail generation failed');
  process.exit(1);
}

await fs.copyFile(result.path, path.resolve(out));
console.log('OK:', path.resolve(out));
