// Shared helpers for the tiktok-science-video scripts. No dependencies beyond Node.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_DIR = process.env.TIKTOK_SCIENCE_DIR || path.join(os.homedir(), 'tiktok-science');
const TOPIC_LOG = path.join(PROJECT_DIR, 'topic-log.md');

function loadScript(file) {
  const abs = path.resolve(file);
  const script = JSON.parse(fs.readFileSync(abs, 'utf8'));
  return { script, dir: path.dirname(abs) };
}

function wordCount(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function totalSeconds(script) {
  return script.beats.reduce((sum, b) => sum + Number(b.seconds || 0), 0);
}

function wrap(text, max) {
  const lines = [];
  let line = '';
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function readTopicLog() {
  try {
    return fs.readFileSync(TOPIC_LOG, 'utf8');
  } catch {
    return '';
  }
}

module.exports = { PROJECT_DIR, TOPIC_LOG, loadScript, wordCount, totalSeconds, wrap, readTopicLog };
