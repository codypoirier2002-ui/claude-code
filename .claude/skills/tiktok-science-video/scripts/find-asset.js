#!/usr/bin/env node
// Usage:
//   node find-asset.js search "<query>" [image|video] [limit]   list NASA media (" [check rights]" marks items to look at closely)
//   node find-asset.js get <nasa_id> <out-file>                 download the best file for an id
//   node find-asset.js archive "<query>" [limit]                search Internet Archive movies (shows license)
//   node find-asset.js archive-get <identifier> <out-file>      download its smallest MP4
//   node find-asset.js pixabay "<query>" [limit]                list Pixabay videos (needs PIXABAY_KEY; untested)
//   node find-asset.js pixabay-get <video-url> <out-file>       download a URL returned by pixabay
//   node find-asset.js music "<Title>" <out.mp3> [seconds]     download a Kevin MacLeod (incompetech.com) track, optionally trimmed
//   node find-asset.js model "<query>" [limit]                 list NASA 3D models (.glb) on science.nasa.gov (planets, moons, spacecraft)
//   node find-asset.js model-get <resource-url|slug> <out.glb>  download the .glb from a science.nasa.gov 3D resource page
// NASA material is generally not copyrighted, but an item can contain third-party copyrighted material (usually noted in its
// credit or description), NASA logos and insignia are protected, and identifiable people need care in commercial use.
// Check each item's credit and description before using it; "search" appends " [check rights]" where they look like a concern.
// Internet Archive items have mixed licenses: only use ones whose license is public domain or CC0/CC-BY, and credit them.
'use strict';
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const API = 'https://images-api.nasa.gov';
const RIGHTS = /copyright|courtesy|©|all rights|getty|reuters|ap photo/i;
const [cmd, ...rest] = process.argv.slice(2);

// Hide the Pixabay API key (the "key" query parameter) wherever a URL is printed or put in an error.
function redact(url) {
  return String(url).replace(/([?&]key=)[^&#]*/g, '$1REDACTED');
}

async function json(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'tiktok-science-video-skill' } });
  if (!res.ok) throw new Error(`${res.status} ${redact(url)}`);
  return res.json();
}

// Stream url into a temp file next to out and rename it into place at the end, so a failed download leaves no partial asset.
async function download(url, out) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${redact(url)}`);
  const tmp = `${out}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, out);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

async function main() {
  if (cmd === 'search') {
    const [query, type = 'image', limit = '8'] = rest;
    const data = await json(`${API}/search?q=${encodeURIComponent(query)}&media_type=${type}&page_size=${limit}`);
    for (const item of data.collection.items.slice(0, Number(limit))) {
      const d = item.data[0];
      const flag = RIGHTS.test(`${d.description || ''} ${d.secondary_creator || ''}`) ? ' [check rights]' : '';
      console.log(`${d.nasa_id} | ${d.title.slice(0, 80)} | ${d.date_created.slice(0, 10)} | ${(d.secondary_creator || d.center || '').slice(0, 30)}${flag}`);
    }
  } else if (cmd === 'get') {
    const [id, out] = rest;
    const files = (await json(`${API}/asset/${encodeURIComponent(id)}`)).collection.items.map((i) => i.href);
    const pick =
      files.find((f) => /~medium\.mp4$/.test(f)) ||
      files.find((f) => /~mobile\.mp4$/.test(f)) ||
      files.find((f) => /~large\.jpg$/.test(f)) ||
      files.find((f) => /~medium\.jpg$/.test(f)) ||
      files.find((f) => /\.(jpg|mp4)$/.test(f));
    if (!pick) throw new Error(`no usable file for ${id}`);
    await download(pick.replace(/^http:/, 'https:'), out);
    console.log(`saved ${out} <- ${pick}`);
  } else if (cmd === 'music') {
    // Kevin MacLeod tracks are CC BY 4.0: free to use, including commercially, if you credit him. Avoid very long tracks (e.g. Fluidscape is 30 min).
    const [title, out, seconds] = rest;
    const url = `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(title)}.mp3`;
    if (seconds) {
      const tmp = `${out}.full.mp3`;
      await download(url, tmp);
      try {
        require('child_process').execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-t', seconds, '-c:a', 'libmp3lame', '-b:a', '128k', out]);
      } catch (e) {
        fs.rmSync(out, { force: true });
        throw e;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    } else {
      await download(url, out);
    }
    console.log(`saved ${out}`);
    console.log(`credit: "${title}" Kevin MacLeod (incompetech.com), licensed under Creative Commons: By Attribution 4.0 License, http://creativecommons.org/licenses/by/4.0/`);
  } else if (cmd === 'archive') {
    const [query, limit = '8'] = rest;
    const q = encodeURIComponent(`(${query}) AND mediatype:movies`);
    const data = await json(
      `https://archive.org/advancedsearch.php?q=${q}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=licenseurl&rows=${limit}&output=json`
    );
    for (const d of data.response.docs) {
      console.log(`${d.identifier} | ${String(d.title).slice(0, 70)} | ${d.licenseurl || 'license: check item page'}`);
    }
  } else if (cmd === 'archive-get') {
    const [id, out] = rest;
    const meta = await json(`https://archive.org/metadata/${encodeURIComponent(id)}`);
    const mp4s = meta.files.filter((f) => /\.mp4$/i.test(f.name) && f.size).sort((a, b) => Number(a.size) - Number(b.size));
    if (!mp4s.length) throw new Error(`no mp4 in ${id}`);
    const url = `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(mp4s[0].name)}`;
    await download(url, out);
    console.log(`saved ${out} <- ${url}`);
  } else if (cmd === 'pixabay') {
    const key = process.env.PIXABAY_KEY;
    if (!key) throw new Error('set PIXABAY_KEY (free key from pixabay.com/api/docs)');
    const [query, limit = '8'] = rest;
    const data = await json(`https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query)}&per_page=${Math.max(3, Number(limit))}`);
    for (const h of data.hits.slice(0, Number(limit))) {
      const v = h.videos.medium || h.videos.small;
      console.log(`${h.id} | ${h.tags.slice(0, 50)} | ${h.duration}s | ${v.width}x${v.height} | ${redact(v.url)}`);
    }
  } else if (cmd === 'model') {
    // NASA's 3D resources (science.nasa.gov/3d-resources) are NASA-made and free to use; credit "NASA" (or the page's credit line).
    const [query, limit = '8'] = rest;
    const hits = await json(
      `https://science.nasa.gov/wp-json/wp/v2/search?search=${encodeURIComponent(`${query} 3d model`)}&subtype=resource&per_page=30`
    );
    const models = hits.filter((h) => /3d-model/.test(h.url)).slice(0, Number(limit));
    if (!models.length) console.log('no 3D models found; try a shorter query (e.g. "mars", "voyager", "saturn")');
    for (const h of models) console.log(`${h.url.replace(/^https:\/\/science\.nasa\.gov\/resource\/|\/$/g, '')} | ${String(h.title).replace(/&#8211;/g, '-').slice(0, 70)}`);
  } else if (cmd === 'model-get') {
    const [ref, out] = rest;
    const page = /^https?:/.test(ref) ? ref : `https://science.nasa.gov/resource/${ref}/`;
    if (!/^https:\/\/science\.nasa\.gov\//.test(page)) throw new Error('model-get only accepts science.nasa.gov resource pages');
    const res = await fetch(page);
    if (!res.ok) throw new Error(`${res.status} ${page}`);
    const html = await res.text();
    const glb = (html.match(/https:\/\/assets\.science\.nasa\.gov[^"' ]+\.glb/g) || [])[0];
    if (!glb) throw new Error(`no .glb link on ${page}`);
    await download(glb, out);
    console.log(`saved ${out} <- ${glb}`);
    console.log('credit: NASA (science.nasa.gov 3D resources)');
  } else if (cmd === 'pixabay-get') {
    const [url, out] = rest;
    await download(url, out);
    console.log(`saved ${out}`);
  } else {
    console.error('usage: find-asset.js search|get|music|model|model-get|archive|archive-get|pixabay|pixabay-get ... (see header)');
    process.exit(2);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
