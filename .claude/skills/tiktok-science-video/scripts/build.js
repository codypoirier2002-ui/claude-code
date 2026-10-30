#!/usr/bin/env node
// Usage: node build.js <script.json> [out.mp4]
// Renders a 1080x1920 MP4 from a script.json.
//  - Narration: each beat's "vo" is spoken with local Piper TTS (run scripts/setup.sh once),
//    or use a beat "audio" file. Beat length = max("seconds", narration + 0.4s).
//  - Captions: the "vo" text is chunked and shown 2-3 words at a time, timed to the audio.
//    "caption" is a small headline shown at the top of the beat.
//  - Visuals per beat: "clips" (a list of short visuals cut together, each {video|image, seconds?}), "video" (clip; optional videoStart, videoFocus), "image" (Ken Burns zoom; optional imageFocus), else an animated gradient from "bg"/"bg2".
//  - Optional crossfades between a beat's clips ("transition": {type, seconds}, script-wide or per beat).
//  - Each visual starts with a quick punch-in zoom (script "punch", default 0.12; 0 = off; per clip "punch": false).
//  - Optional top-level "music" file is mixed under the narration.
// Appends the topic to topic-log.md in the project directory.
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PROJECT_DIR, TOPIC_LOG, loadScript, wrap } = require('./lib');

const FONT = process.env.TIKTOK_FONT || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const CACHE = process.env.TIKTOK_CACHE_DIR || path.join(os.homedir(), '.cache', 'tiktok-science');
const PY = process.env.TTS_PYTHON || path.join(CACHE, 'venv', 'bin', 'python');
const VOICE = process.env.TTS_MODEL || path.join(CACHE, 'voices', 'en_US-lessac-medium.onnx');

const [scriptFile, outArg] = process.argv.slice(2);
if (!scriptFile) {
  console.error('usage: node build.js <script.json> [out.mp4]');
  process.exit(2);
}

const { script, dir } = loadScript(scriptFile);
const W = script.width || 1080;
const H = script.height || 1920;
const FPS = script.fps || 30;
const ACCENT = script.accent || '#ffd166';
const slug = String(script.topic || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const outFile = path.resolve(outArg || path.join(PROJECT_DIR, 'out', `${slug}.mp4`));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-build-'));

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const duration = (file) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

function synth(text) {
  const key = crypto.createHash('sha1').update(text + VOICE).digest('hex').slice(0, 16);
  const out = path.join(CACHE, 'tts', `${key}.wav`);
  if (fs.existsSync(out)) return out;
  if (!fs.existsSync(PY) || !fs.existsSync(VOICE)) {
    console.error('Narration not set up. Run scripts/setup.sh once, or give each beat an "audio" file.');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(PY, ['-m', 'piper', '-m', VOICE, '-f', out], { input: text, stdio: ['pipe', 'ignore', 'inherit'] });
  return out;
}

// Split the spoken text into short caption chunks (max 3 words, break after punctuation).
function chunk(text) {
  const chunks = [];
  let cur = [];
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    cur.push(word);
    if (cur.length >= 3 || /[.,;:!?]$/.test(word)) {
      chunks.push(cur.join(' '));
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur.join(' '));
  return chunks;
}

// Time each chunk by its share of the characters, with extra weight on trailing punctuation.
function timings(chunks, start, end) {
  const weights = chunks.map((c) => c.length + (/[.!?]$/.test(c) ? 6 : /[,;:]$/.test(c) ? 3 : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let t = start;
  return chunks.map((c, i) => {
    const span = ((end - start) * weights[i]) / total;
    const item = { text: c, from: t, to: t + span };
    t += span;
    return item;
  });
}

// Builds ffmpeg inputs and a filter graph ending in [bg] for one visual: video clip, image, or gradient.
// item: { video, videoStart, videoFocus } | { image } | { bg, bg2 }
function visual(item, secs) {
  const inputs = [];
  let filter;
  if (item.video) {
    // "videoStart" seeks into the clip; "videoFocus" (0 left .. 1 right, default 0.5) picks the crop for landscape footage.
    inputs.push('-stream_loop', '-1', '-ss', String(item.videoStart || 0), '-t', String(secs), '-i', path.resolve(dir, item.video));
    const focus = item.videoFocus ?? 0.5;
    filter = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-${W})*${focus}:(ih-${H})*0.5,fps=${FPS},eq=brightness=-0.12[bg]`;
  } else if (item.image) {
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', String(secs), '-i', path.resolve(dir, item.image));
    const frames = Math.round(secs * FPS);
    filter =
      `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}:(iw-${W * 2})*${item.imageFocus ?? 0.5}:(ih-${H * 2})*0.5,` +
      `zoompan=z='min(1+0.0007*on,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},` +
      `eq=brightness=-0.15,trim=end_frame=${frames}[bg]`;
  } else {
    inputs.push('-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=${item.bg || '#0b1d2e'}:c1=${item.bg2 || '#1d4e6e'}:speed=0.02:r=${FPS}:d=${secs}`);
    filter = '[0:v]null[bg]';
  }
  // Punch-in: each visual starts slightly zoomed in and settles over ~0.28 s, which makes cuts feel snappy.
  // Script-level "punch" sets the zoom amount (default 0.12, 0 turns it off).
  const punch = script.punch ?? 0.12;
  if (punch > 0 && item.punch !== false) {
    const z = `(1+${punch}*max(0,1-t/0.28))`;
    filter = filter.replace(
      /\[bg\]$/,
      `,scale=w='trunc(${W}*${z}/2)*2':h='trunc(${H}*${z}/2)*2':eval=frame,crop=${W}:${H}[bg]`
    );
  }
  return { inputs, filter };
}

const segments = script.beats.map((beat, i) => {
  const audio = beat.audio ? path.resolve(dir, beat.audio) : beat.vo ? synth(beat.vo) : null;
  const narration = audio ? duration(audio) : 0;
  const secs = Math.max(Number(beat.seconds || 0), narration ? narration + 0.4 : 0);
  const seg = path.join(work, `seg${i}.mp4`);

  // Visual input and base filter. "clips" = several short visuals cut together inside the beat.
  let inputs = [];
  let base;
  if (beat.clips && beat.clips.length) {
    const weights = beat.clips.map((c) => Number(c.seconds) || 1);
    const sum = weights.reduce((x, y) => x + y, 0);
    const durs = weights.map((w) => (secs * w) / sum);
    // Optional crossfade between clips: {"type": "fade", "seconds": 0.25}. Types are ffmpeg xfade names (fade, fadeblack, slideleft, wipeleft, circleopen, ...).
    const tr = beat.transition ?? script.transition;
    const tf = tr && beat.clips.length > 1 ? Math.min(Number(tr.seconds) || 0.25, 0.4 * Math.min(...durs)) : 0;
    const files = beat.clips.map((clip, k) => {
      const d = durs[k] + (tf && k < durs.length - 1 ? tf : 0);
      const v = visual(clip, d);
      const f = path.join(work, `clip${i}_${k}.mp4`);
      ff([...v.inputs, '-filter_complex', v.filter, '-map', '[bg]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20', '-t', d.toFixed(3), f]);
      return f;
    });
    const joined = path.join(work, `vis${i}.mp4`);
    if (tf) {
      let chain = '';
      let last = '[0:v]';
      let offset = 0;
      for (let k = 1; k < files.length; k++) {
        offset += durs[k - 1];
        const label = k === files.length - 1 ? '[out]' : `[x${k}]`;
        chain += `${last}[${k}:v]xfade=transition=${tr.type || 'fade'}:duration=${tf.toFixed(3)}:offset=${offset.toFixed(3)}${label};`;
        last = label;
      }
      ff([...files.flatMap((f) => ['-i', f]), '-filter_complex', chain.slice(0, -1), '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20', '-t', secs.toFixed(3), joined]);
    } else {
      const l = path.join(work, `clips${i}.txt`);
      fs.writeFileSync(l, files.map((f) => `file '${f}'`).join('\n'));
      ff(['-f', 'concat', '-safe', '0', '-i', l, '-c', 'copy', joined]);
    }
    inputs = ['-i', joined];
    base = '[0:v]null[bg]';
  } else {
    const v = visual(beat, secs);
    inputs = v.inputs;
    base = v.filter;
  }

  // Captions: one drawtext per wrapped line so every line is centered.
  const draws = [];
  const drawLines = (text, wrapAt, style, yFirst, lineH, enable) => {
    wrap(text, wrapAt).split('\n').forEach((line, k, all) => {
      const f = path.join(work, `t${i}_${draws.length}.txt`);
      fs.writeFileSync(f, line);
      const y = typeof yFirst === 'function' ? yFirst(all.length, k) : yFirst + k * lineH;
      draws.push(
        `drawtext=fontfile=${FONT}:textfile=${f}:expansion=none:${style}:x=(w-text_w)/2:y=${y}` + (enable ? `:enable='${enable}'` : '')
      );
    });
  };
  if (beat.caption) {
    drawLines(beat.caption, 26, `fontcolor=${ACCENT}:fontsize=54:borderw=4:bordercolor=black@0.8`, 230, 70);
  }
  if (beat.vo || beat.words) {
    const spoken = beat.vo || beat.words;
    const start = audio ? 0.05 : 0.2;
    const end = audio ? narration + 0.05 : secs - 0.2;
    timings(chunk(spoken), start, end).forEach((c) => {
      const t0 = c.from.toFixed(3);
      const style =
        `fontcolor=white:fontsize='if(lt(t-${t0},0.12),96,84)':borderw=7:bordercolor=black`;
      drawLines(
        c.text.toUpperCase(),
        14,
        style,
        (n, k) => `(h-${n}*100)/2+${k * 100}+120`,
        100,
        `between(t,${t0},${c.to.toFixed(3)})`
      );
    });
  }
  const graph = [base, `[bg]${draws.length ? draws.join(',') : 'null'}[v]`];

  // Audio
  let audioArgs;
  if (audio) {
    inputs.push('-i', audio);
    graph.push(`[1:a]adelay=50|50,apad=whole_dur=${secs},aformat=sample_rates=48000:channel_layouts=stereo[a]`);
    audioArgs = [];
  } else {
    inputs.push('-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`);
    graph.push(`[1:a]atrim=0:${secs}[a]`);
    audioArgs = [];
  }

  ff([
    ...inputs,
    '-filter_complex', graph.join(';'),
    '-map', '[v]', '-map', '[a]', ...audioArgs,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-t', secs.toFixed(3), seg,
  ]);
  return { seg, secs };
});

const total = segments.reduce((a, s) => a + s.secs, 0);
const list = path.join(work, 'list.txt');
fs.writeFileSync(list, segments.map((s) => `file '${s.seg}'`).join('\n'));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const joined = path.join(work, 'joined.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
// Final audio pass: optional music bed (faded in/out), then loudness-normalize to about -14 LUFS for short-form platforms.
const norm = 'loudnorm=I=-14:TP=-1.5:LRA=11';
if (script.music) {
  ff([
    '-i', joined, '-stream_loop', '-1', '-i', path.resolve(dir, script.music),
    '-filter_complex',
    `[1:a]volume=${script.musicVolume || 0.12},afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5[m];` +
      `[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${norm}[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-shortest', '-movflags', '+faststart', outFile,
  ]);
} else {
  ff(['-i', joined, '-map', '0:v', '-map', '0:a', '-af', norm, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', outFile]);
}

fs.mkdirSync(PROJECT_DIR, { recursive: true });
fs.appendFileSync(TOPIC_LOG, `- ${new Date().toISOString().slice(0, 10)} | ${script.topic} | ${script.claim} | ${outFile}\n`, 'utf8');
fs.rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${outFile} (${total.toFixed(1)}s)`);
console.log(`Logged topic to ${TOPIC_LOG}`);
