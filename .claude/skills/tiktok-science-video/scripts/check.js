#!/usr/bin/env node
// Usage: node check.js <script.json> [video.mp4]
// Checks a video script against the skill's format rules. Exits 1 on errors.
'use strict';
const { execFileSync } = require('child_process');
const { loadScript, wordCount, totalSeconds, readTopicLog, wrap } = require('./lib');

const [scriptFile, videoFile] = process.argv.slice(2);
if (!scriptFile) {
  console.error('usage: node check.js <script.json> [video.mp4]');
  process.exit(2);
}

const { script } = loadScript(scriptFile);
const errors = [];
const warnings = [];

for (const field of ['topic', 'claim', 'beats', 'sources']) {
  if (!script[field] || (Array.isArray(script[field]) && !script[field].length)) {
    errors.push(`missing "${field}"`);
  }
}

const beats = script.beats || [];
const total = totalSeconds(script);
if (total < 30 || total > 60) errors.push(`total length ${total}s is outside 30–60s`);

beats.forEach((beat, i) => {
  const name = beat.id || `beat ${i + 1}`;
  const secs = Number(beat.seconds || 0);
  if (!secs) errors.push(`${name}: no "seconds"`);
  if (i === 0 && secs > 2) warnings.push(`hook is ${secs}s; keep it to 2s or less`);
  const words = wordCount(beat.vo);
  if (secs && words) {
    const rate = words / secs;
    if (rate > 3.2) warnings.push(`${name}: ${words} words in ${secs}s is too fast (${rate.toFixed(1)} w/s)`);
    if (rate < 1.5) warnings.push(`${name}: ${words} words in ${secs}s is too slow (${rate.toFixed(1)} w/s)`);
  }
  const lines = wrap(beat.caption, 22).split('\n').filter(Boolean).length;
  if (lines > 4) warnings.push(`${name}: caption wraps to ${lines} lines; shorten it to 4 or fewer`);
});

const log = readTopicLog().toLowerCase();
if (script.topic && log.includes(script.topic.toLowerCase())) {
  warnings.push(`topic "${script.topic}" already appears in topic-log.md`);
}

if (videoFile) {
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', videoFile]).toString()
  );
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const duration = Number(probe.format.duration);
  if (!v) errors.push('video has no video stream');
  else {
    if (v.width !== 1080 || v.height !== 1920) errors.push(`video is ${v.width}x${v.height}, expected 1080x1920`);
  }
  if (duration < 30 || duration > 60) errors.push(`video duration ${duration.toFixed(1)}s is outside 30–60s`);
  if (!probe.streams.some((s) => s.codec_type === 'audio')) warnings.push('video has no audio track');
}

for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(errors.length ? `FAIL: ${errors.length} error(s), ${warnings.length} warning(s)` : `PASS: ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
