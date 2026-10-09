// Original pixel art, defined as character maps and rendered to textures at
// runtime. No external image assets, so there is nothing to license.
import { Texture } from 'pixi.js';
import type { AgentRole } from '../types.ts';

type Palette = Record<string, string>;

// 12x16 crew member, front view (idle).
const FRONT = [
  '....kkkk....',
  '...khhhhk...',
  '..khhhhhhk..',
  '..kssssssk..',
  '..ksvssvsk..',
  '..kssssssk..',
  '...kssssk...',
  '..kcccccck..',
  '.kccwccccck.',
  'kdccccccccdk',
  'ksccccccccsk',
  '.kcccccccck.',
  '..kddkkddk..',
  '..kddkkddk..',
  '..kbbkkbbk..',
  '..kkkkkkkk..',
];
// Blink frame: eyes closed.
const FRONT_BLINK = FRONT.map((r, i) => (i === 4 ? '..kssssssk..' : r));
// Back view at a workstation, two typing frames.
const BACK_A = [
  '....kkkk....',
  '...khhhhk...',
  '..khhhhhhk..',
  '..khhhhhhk..',
  '..khhhhhhk..',
  '..kshhhhsk..',
  '...kssssk...',
  '..kcccccck..',
  '.kcccccccck.',
  'sdccccccccdk',
  'kdccccccccsk',
  '.kcccccccck.',
  '..kddkkddk..',
  '..kddkkddk..',
  '..kbbkkbbk..',
  '..kkkkkkkk..',
];
const BACK_B = BACK_A.map((r, i) => (i === 9 ? 'kdccccccccds' : i === 10 ? 'ksccccccccdk' : r));

const ICONS: Record<string, string[]> = {
  alert: ['.aaaaa.', 'aaakaaa', 'aaakaaa', 'aaakaaa', 'aaaaaaa', 'aaakaaa', '.aaaaa.'],
  fail: ['.rrrrr.', 'rkrrrkr', 'rrkrkrr', 'rrrkrrr', 'rrkrkrr', 'rkrrrkr', '.rrrrr.'],
  done: ['.ggggg.', 'ggggggg', 'gggggkg', 'kgggkgg', 'gkgkggg', 'ggkgggg', '.ggggg.'],
  sleep: ['.......', '.zzzz..', '...z...', '..z....', '.zzzz..', '.......', '.......'],
};

const BASE: Palette = { k: '#0a0e13', v: '#0a0e13', w: '#e8f5ee', b: '#262b33' };
const ICON_PAL: Palette = { k: '#0a0e13', a: '#ffb43c', r: '#ff4f5e', g: '#3cf58c', z: '#9fb7ad' };

export const CREW: Record<AgentRole, Palette & { accent: string }> = {
  commander: { ...BASE, s: '#c68642', h: '#3b2a1a', c: '#2fbf71', d: '#1b7a47', accent: '#3cf58c' },
  researcher: { ...BASE, s: '#f1c27d', h: '#e8d27a', c: '#31b8c9', d: '#1d6f7a', accent: '#3fe0f0' },
  writer: { ...BASE, s: '#8d5524', h: '#1a1a1a', c: '#a070e0', d: '#5e3d94', accent: '#c59bff' },
  reviewer: { ...BASE, s: '#e0ac69', h: '#b5532b', c: '#4f7ee8', d: '#2c4a94', accent: '#7aa2ff' },
};

function toTexture(map: string[], pal: Palette): Texture {
  const h = map.length;
  const w = map[0].length;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const color = pal[map[y][x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  return tex;
}

export interface CrewTextures {
  front: Texture;
  blink: Texture;
  typeA: Texture;
  typeB: Texture;
}

export function crewTextures(role: AgentRole): CrewTextures {
  const pal = CREW[role];
  return { front: toTexture(FRONT, pal), blink: toTexture(FRONT_BLINK, pal), typeA: toTexture(BACK_A, pal), typeB: toTexture(BACK_B, pal) };
}

export function iconTextures(): Record<'alert' | 'fail' | 'done' | 'sleep', Texture> {
  return {
    alert: toTexture(ICONS.alert, ICON_PAL),
    fail: toTexture(ICONS.fail, ICON_PAL),
    done: toTexture(ICONS.done, ICON_PAL),
    sleep: toTexture(ICONS.sleep, ICON_PAL),
  };
}
