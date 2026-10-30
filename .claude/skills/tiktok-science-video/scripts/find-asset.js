#!/usr/bin/env node
// Usage:
//   node find-asset.js search "<query>" [image|video] [limit]   list public-domain NASA media
//   node find-asset.js get <nasa_id> <out-file>                 download the best file for an id
//   node find-asset.js archive "<query>" [limit]                search Internet Archive movies (shows license)
//   node find-asset.js archive-get <identifier> <out-file>      download its smallest MP4
//   node find-asset.js pixabay "<query>" [limit]                list Pixabay videos (needs PIXABAY_KEY; untested)
//   node find-asset.js pixabay-get <video-url> <out-file>       download a URL returned by pixabay
//   node find-asset.js music "<Title>" <out.mp3> [seconds]     download a Kevin MacLeod (incompetech.com) track, optionally trimmed
// NASA media is generally free to use without permission, but some items carry third-party credits.
// Internet Archive items have mixed licenses: only use ones whose license is public domain or CC0/CC-BY, and credit them.
'use strict';
const fs = require('fs');

const API = 'https://images-api.nasa.gov';
const [cmd, ...rest] = process.argv.slice(2);

async function json(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'tiktok-science-video-skill' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function main() {
  if (cmd === 'search') {
    const [query, type = 'image', limit = '8'] = rest;
    const data = await json(`${API}/search?q=${encodeURIComponent(query)}&media_type=${type}&page_size=${limit}`);
    for (const item of data.collection.items.slice(0, Number(limit))) {
      const d = item.data[0];
      console.log(`${d.nasa_id} | ${d.title.slice(0, 80)} | ${d.date_created.slice(0, 10)} | ${(d.secondary_creator || d.center || '').slice(0, 30)}`);
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
    const res = await fetch(pick.replace(/^http:/, 'https:'));
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`saved ${out} <- ${pick}`);
  } else if (cmd === 'music') {
    // Kevin MacLeod tracks are CC BY 4.0: free to use, including commercially, if you credit him. Avoid very long tracks (e.g. Fluidscape is 30 min).
    const [title, out, seconds] = rest;
    const url = `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(title)}.mp3`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (seconds) {
      const tmp = `${out}.full.mp3`;
      fs.writeFileSync(tmp, buf);
      require('child_process').execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-t', seconds, '-c:a', 'libmp3lame', '-b:a', '128k', out]);
      fs.unlinkSync(tmp);
    } else {
      fs.writeFileSync(out, buf);
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
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`saved ${out} <- ${url}`);
  } else if (cmd === 'pixabay') {
    const key = process.env.PIXABAY_KEY;
    if (!key) throw new Error('set PIXABAY_KEY (free key from pixabay.com/api/docs)');
    const [query, limit = '8'] = rest;
    const data = await json(`https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query)}&per_page=${Math.max(3, Number(limit))}`);
    for (const h of data.hits.slice(0, Number(limit))) {
      const v = h.videos.medium || h.videos.small;
      console.log(`${h.id} | ${h.tags.slice(0, 50)} | ${h.duration}s | ${v.width}x${v.height} | ${v.url}`);
    }
  } else if (cmd === 'pixabay-get') {
    const [url, out] = rest;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`saved ${out}`);
  } else {
    console.error('usage: find-asset.js search|get|music|archive|archive-get|pixabay|pixabay-get ... (see header)');
    process.exit(2);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
