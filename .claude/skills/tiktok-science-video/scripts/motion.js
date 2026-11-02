#!/usr/bin/env node
// Usage: node motion.js <scene> <out.mp4> <seconds> [params-json-or-file] [--base <dir>] [--fps 30] [--size 1080x1920]
// Renders a code-driven motion graphic (2D canvas or 3D three.js) to an MP4, frame by frame, in headless Chromium.
//  - <scene> is a built-in scene name ("2d/counter", "2d/bars", "2d/scale", "2d/journey", "3d/model", "3d/planet",
//    "3d/orbit") or a path to your own .html scene.
//  - Params are passed to the scene as window.PARAMS. Asset paths in params (model, texture, image) are relative to
//    --base (default: the current directory) and are served to the page from there.
//  - Rendering is deterministic: the scene draws each frame from the time t alone (window.renderFrame(t)), so the
//    output does not depend on machine speed. See scenes/README.md for the scene contract.
// Needs Playwright with Chromium (preinstalled in Claude Code cloud sessions) and ffmpeg. three.js is installed once
// into ~/.cache/tiktok-science/motion (pinned version) the first time a 3D scene is rendered.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const THREE_VERSION = '0.170.0';
const SKILL = path.resolve(__dirname, '..');
const SCENES = path.join(SKILL, 'scenes');
const CACHE = process.env.TIKTOK_CACHE_DIR || path.join(os.homedir(), '.cache', 'tiktok-science');
const LIB = path.join(CACHE, 'motion');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

function parseArgs(argv) {
  const pos = [];
  const opt = { base: process.cwd(), fps: 30, size: '1080x1920' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') opt.base = argv[++i];
    else if (argv[i] === '--fps') opt.fps = Number(argv[++i]);
    else if (argv[i] === '--size') opt.size = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

function ensureThree() {
  if (fs.existsSync(path.join(LIB, 'node_modules', 'three', 'build', 'three.module.js'))) return;
  fs.mkdirSync(LIB, { recursive: true });
  console.error(`Installing three@${THREE_VERSION} into ${LIB} (one time)...`);
  execFileSync('npm', ['install', '--prefix', LIB, '--no-audit', '--no-fund', '--silent', `three@${THREE_VERSION}`], { stdio: 'inherit' });
}

// Serves /scenes/* from the skill, /lib/three/* from the cache, and /base/* from the asset directory.
// Bound to 127.0.0.1; every path is resolved and checked to stay inside its root.
function serve(base) {
  const roots = { scenes: SCENES, lib: path.join(LIB, 'node_modules'), base: path.resolve(base) };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const [, root, ...rest] = url.split('/');
    const top = roots[root];
    const file = top && path.resolve(top, rest.join('/'));
    if (!file || (file !== top && !file.startsWith(top + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Built-in scenes are served from the skill; a custom .html scene must sit inside --base and imports helpers from
// "/scenes/common.js" by absolute URL.
function scenePath(scene, base) {
  if (/^(2d|3d)\/[a-z0-9-]+$/.test(scene)) return `/scenes/${scene}.html`;
  const abs = path.resolve(scene);
  const rel = path.relative(path.resolve(base), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`custom scene ${abs} must be inside --base ${path.resolve(base)}`);
  }
  return `/base/${rel.split(path.sep).join('/')}`;
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const [scene, out, secondsArg, paramsArg] = pos;
  if (!scene || !out || !secondsArg) {
    console.error('usage: node motion.js <scene> <out.mp4> <seconds> [params-json-or-file] [--base dir] [--fps 30] [--size 1080x1920]');
    process.exit(2);
  }
  let params = {};
  if (paramsArg) params = JSON.parse(fs.existsSync(paramsArg) ? fs.readFileSync(paramsArg, 'utf8') : paramsArg);
  const [W, H] = opt.size.split('x').map(Number);
  const seconds = Number(secondsArg);
  const frames = Math.max(1, Math.round(seconds * opt.fps));
  const page3d = /^3d\//.test(scene) || /three/.test(fs.existsSync(scene) ? fs.readFileSync(scene, 'utf8') : '');
  if (page3d) ensureThree();

  const { chromium } = require('playwright');
  const server = await serve(opt.base);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let ffmpeg;
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.addInitScript((p) => { window.PARAMS = p; }, { ...params, duration: seconds, fps: opt.fps, width: W, height: H });
    await page.goto(origin + scenePath(scene, opt.base));
    try {
      await page.waitForFunction('window.sceneReady === true', null, { timeout: 120000 });
    } catch (e) {
      throw new Error(`scene did not become ready: ${errors.join(' | ') || e.message}`);
    }

    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(opt.fps), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '17', '-r', String(opt.fps),
      '-frames:v', String(frames), path.resolve(out),
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((resolve, reject) => ffmpeg.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`)))));

    const t0 = Date.now();
    for (let f = 0; f < frames; f++) {
      await page.evaluate((t) => window.renderFrame(t), f / opt.fps);
      const png = await page.screenshot({ type: 'png' });
      if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
      if (errors.length) throw new Error(`scene error at frame ${f}: ${errors.join(' | ')}`);
    }
    ffmpeg.stdin.end();
    await done;
    console.log(`Wrote ${path.resolve(out)} (${frames} frames, ${(frames / opt.fps).toFixed(2)}s, rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
