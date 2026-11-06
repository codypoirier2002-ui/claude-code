// The seven VR scenes (§8.7): pure data. The table order is also the order the
// 🌅 Scene button cycles through. xr/panorama.ts draws the panoramas.

export type ParticleKind = "motes" | "fireflies" | "rain";

export interface Environment {
  id: string;
  name: string;
  note: string;
  /** Equirectangular panorama, relative to the app base (`skies/{id}.jpg`). The clock scene has none. */
  image?: string;
  /** 320×160 thumbnail (`skies/thumbs/{id}.jpg`): the scene picker and the chat backdrop. */
  thumb?: string;
  /** Where the horizon sits in the panorama, 0–1 from the top. */
  horizon: number;
  /** Width of the mirrored blend at the wrap seam (0 turns it off). */
  seam: number;
  /** HemisphereLight colours. */
  hemisphere: { sky: number; ground: number };
  /** DirectionalLight colour and intensity. */
  key: { color: number; intensity: number };
  particles: { kind: ParticleKind; color: number; count: number };
}

export const CLOCK_ENVIRONMENT_ID = "clock";

function panorama(id: string): Pick<Environment, "image" | "thumb"> {
  return { image: `skies/${id}.jpg`, thumb: `skies/thumbs/${id}.jpg` };
}

const TABLE: Environment[] = [
  {
    id: CLOCK_ENVIRONMENT_ID,
    name: "Follows the clock",
    note: "Dawn, day, golden hour, dusk, night",
    horizon: 0.5,
    seam: 0,
    hemisphere: { sky: 0xcfe3ff, ground: 0x1a1410 },
    key: { color: 0xffe6c8, intensity: 1.3 },
    particles: { kind: "motes", color: 0xfff4d0, count: 90 },
  },
  {
    id: "beach",
    name: "Golden beach",
    note: "Sunset on a quiet shore",
    ...panorama("beach"),
    horizon: 0.5,
    seam: 0,
    hemisphere: { sky: 0xffd9b8, ground: 0x6b4a3a },
    key: { color: 0xffc890, intensity: 1.5 },
    particles: { kind: "motes", color: 0xffd9a8, count: 140 },
  },
  {
    id: "lake",
    name: "Night lake",
    note: "Milky Way over still water",
    ...panorama("lake"),
    horizon: 0.5,
    seam: 0,
    hemisphere: { sky: 0x9fb8ff, ground: 0x0c1418 },
    key: { color: 0xb8c8ff, intensity: 0.9 },
    particles: { kind: "fireflies", color: 0xd8ff8a, count: 90 },
  },
  {
    id: "loft",
    name: "Rainy loft",
    note: "Cozy, with the city in the rain",
    ...panorama("loft"),
    horizon: 0.5,
    seam: 0,
    hemisphere: { sky: 0xffd2a0, ground: 0x3a2a20 },
    key: { color: 0xffcf98, intensity: 1.2 },
    particles: { kind: "motes", color: 0xffd6a0, count: 120 },
  },
  {
    id: "deck",
    name: "Orbit deck",
    note: "Space station above Earth",
    ...panorama("deck"),
    horizon: 0.5,
    seam: 0,
    hemisphere: { sky: 0xb8d4ff, ground: 0x30384a },
    key: { color: 0xdce8ff, intensity: 1.4 },
    particles: { kind: "motes", color: 0xbcd8ff, count: 160 },
  },
  {
    id: "forest",
    name: "Misty forest",
    note: "Sunbeams at dawn",
    ...panorama("forest"),
    horizon: 0.5,
    seam: 0,
    hemisphere: { sky: 0xe8f0c8, ground: 0x2a3a1e },
    key: { color: 0xfff0b8, intensity: 1.4 },
    particles: { kind: "motes", color: 0xfff2c0, count: 220 },
  },
  {
    id: "rooftop",
    name: "Neon rooftop",
    note: "Rain-slicked, glowing city",
    ...panorama("rooftop"),
    horizon: 0.5,
    seam: 0,
    hemisphere: { sky: 0xc8a0ff, ground: 0x180a28 },
    key: { color: 0xff9ad8, intensity: 1.2 },
    particles: { kind: "rain", color: 0xd8c8ff, count: 700 },
  },
];

export const ENVIRONMENTS: readonly Environment[] = Object.freeze(TABLE);

/** The scene with that id, or the clock scene. */
export function environmentById(id: string | null | undefined): Environment {
  return ENVIRONMENTS.find((e) => e.id === id) ?? ENVIRONMENTS[0];
}

/** The next scene in table order, wrapping from the last back to the clock. */
export function nextEnvironment(id: string | null | undefined): Environment {
  const i = ENVIRONMENTS.indexOf(environmentById(id));
  return ENVIRONMENTS[(i + 1) % ENVIRONMENTS.length];
}

/** "#rrggbb" for a colour number, for CSS. */
export function cssColor(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** The message when a panorama fails to load (§8.7): the panel in VR, the toast in 2D. */
export function sceneLoadFailedText(name: string): string {
  return `Couldn't load the ${name} scene. Going back to the clock sky.`;
}

/** Where a scene's soundscape lives, relative to the app base (§8.9). Every scene has one, the clock too. */
export function ambienceFile(id: string): string {
  return `ambience/${id}.ogg`;
}
