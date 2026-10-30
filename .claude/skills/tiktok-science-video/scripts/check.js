#!/usr/bin/env node
// Usage: node check.js <script.json> [video.mp4]
// Checks a video script against the skill's format rules. Exits 1 on errors.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadScript, wordCount, totalSeconds, readTopicLog, wrap } = require('./lib');

const [scriptFile, videoFile] = process.argv.slice(2);
if (!scriptFile) {
  console.error('usage: node check.js <script.json> [video.mp4]');
  process.exit(2);
}

const { script, dir } = loadScript(scriptFile);
const errors = [];
const warnings = [];
const duration = (file) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

for (const field of ['topic', 'claim', 'beats', 'sources']) {
  if (!script[field] || (Array.isArray(script[field]) && !script[field].length)) {
    errors.push(`missing "${field}"`);
  }
}

const beats = Array.isArray(script.beats) ? script.beats : [];
if (script.beats && !Array.isArray(script.beats)) errors.push('"beats" must be an array');
const total = beats.length ? totalSeconds(script) : 0;
if (total < 30 || total > 60) errors.push(`total length ${total}s is outside 30–60s`);

beats.forEach((beat, i) => {
  const name = beat.id || `beat ${i + 1}`;
  const secs = typeof beat.seconds === 'number' ? beat.seconds : NaN;
  const validSecs = Number.isFinite(secs) && secs > 0;
  if (!validSecs) errors.push(`${name}: "seconds" must be a number greater than 0 (got ${JSON.stringify(beat.seconds)})`);
  if (i === 0 && validSecs && secs > 2) warnings.push(`hook is ${secs}s; keep it to 2s or less`);
  if (beat.audio) {
    const audioFile = typeof beat.audio === 'string' ? path.resolve(dir, beat.audio) : null;
    if (!audioFile) errors.push(`${name}: "audio" must be a file path (got ${JSON.stringify(beat.audio)})`);
    else if (!fs.existsSync(audioFile)) errors.push(`${name}: audio file not found: ${audioFile}`);
    else if (i === 0) {
      // build.js stretches a beat to its "audio" length + 0.4s, so a long hook recording outruns the declared "seconds".
      let audioSecs;
      try {
        audioSecs = duration(audioFile);
        if (!Number.isFinite(audioSecs)) throw new Error('ffprobe gave no duration');
      } catch {
        errors.push(`${name}: cannot read audio duration: ${audioFile}`);
      }
      if (audioSecs !== undefined) {
        const effective = Math.max(validSecs ? secs : 0, audioSecs + 0.4);
        if (effective > 3) warnings.push(`hook runs ${effective.toFixed(2)}s with its audio; keep it to 3s or less`);
      }
    }
  }
  const words = wordCount(beat.vo);
  if (validSecs && words) {
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
  const videoSecs = Number(probe.format.duration);
  if (!v) errors.push('video has no video stream');
  else {
    if (v.width !== 1080 || v.height !== 1920) errors.push(`video is ${v.width}x${v.height}, expected 1080x1920`);
  }
  if (videoSecs < 30 || videoSecs > 60) errors.push(`video duration ${videoSecs.toFixed(1)}s is outside 30–60s`);
  if (!probe.streams.some((s) => s.codec_type === 'audio')) errors.push('video has no audio stream');
}

for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(errors.length ? `FAIL: ${errors.length} error(s), ${warnings.length} warning(s)` : `PASS: ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
