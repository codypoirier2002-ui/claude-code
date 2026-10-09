// Top-down pixel-art space station drawn with PixiJS. Four connected rooms,
// one crew member each. Animation is driven only by the agent states the
// backend reports: a workstation screen scrolls only while a step is
// actually running, and everything goes dark when the link is down.
import 'pixi.js/unsafe-eval'; // lets Pixi run under the dashboard's strict CSP (no eval)
import { Application, Container, Graphics, Sprite } from 'pixi.js';
import { useEffect, useRef, useState } from 'react';
import type { Agent, AgentRole, AgentVisualState } from '../types.ts';
import { crewTextures, iconTextures, CREW } from './sprites.ts';

export const SCENE_W = 640;
export const SCENE_H = 384;

interface RoomDef {
  role: AgentRole;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  floorA: number;
  floorB: number;
}

export const ROOMS: RoomDef[] = [
  { role: 'commander', name: 'Command Center', x: 24, y: 24, w: 288, h: 164, floorA: 0x14211c, floorB: 0x111c18 },
  { role: 'researcher', name: 'Research Lab', x: 328, y: 24, w: 288, h: 164, floorA: 0x13202a, floorB: 0x101b24 },
  { role: 'writer', name: 'Content Studio', x: 24, y: 196, w: 288, h: 164, floorA: 0x1b1726, floorB: 0x171421 },
  { role: 'reviewer', name: 'Review Station', x: 328, y: 196, w: 288, h: 164, floorA: 0x141a2a, floorB: 0x111624 },
];

const hex = (s: string) => parseInt(s.slice(1), 16);
const WALL = 0x24323c;
const WALL_HI = 0x3a5060;
const WALL_LO = 0x111a20;

function r(g: Graphics, x: number, y: number, w: number, h: number, color: number, alpha = 1) {
  g.rect(x, y, w, h).fill({ color, alpha });
}

function drawStatic(g: Graphics) {
  // Space and stars (deterministic so the layout never "twinkles" on its own).
  r(g, 0, 0, SCENE_W, SCENE_H, 0x04070a);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 140; i++) r(g, Math.floor(rand() * SCENE_W), Math.floor(rand() * SCENE_H), 1, 1, rand() > 0.85 ? 0x9fd8ff : 0x5a6b78);
  // Hull.
  r(g, 14, 14, SCENE_W - 28, SCENE_H - 28, 0x0b1116);
  r(g, 14, 14, SCENE_W - 28, 2, 0x2a3a46);
  r(g, 14, SCENE_H - 16, SCENE_W - 28, 2, 0x2a3a46);
  // Corridors linking the rooms (drawn under the door frames).
  const corridor = 0x1a252d;
  r(g, 300, 92, 40, 28, corridor); // CC <-> Lab
  r(g, 300, 264, 40, 28, corridor); // Studio <-> Review
  r(g, 232, 176, 32, 32, corridor); // CC <-> Studio
  r(g, 500, 176, 32, 32, corridor); // Lab <-> Review
  for (let i = 0; i < 5; i++) {
    r(g, 302 + i * 8, 105, 4, 2, 0x2c3e4a);
    r(g, 302 + i * 8, 277, 4, 2, 0x2c3e4a);
  }

  for (const room of ROOMS) {
    const { x, y, w, h } = room;
    // Floor tiles.
    for (let ty = 0; ty < h; ty += 8) {
      for (let tx = 0; tx < w; tx += 8) r(g, x + tx, y + ty, 8, 8, ((tx + ty) / 8) % 2 ? room.floorA : room.floorB);
    }
    // Walls: thick back wall, thinner sides.
    r(g, x - 6, y - 10, w + 12, 12, WALL);
    r(g, x - 6, y - 10, w + 12, 1, WALL_HI);
    r(g, x - 6, y + h, w + 12, 6, WALL);
    r(g, x - 6, y, 6, h, WALL);
    r(g, x + w, y, 6, h, WALL);
    r(g, x - 6, y + h + 5, w + 12, 1, WALL_LO);
    // Back-wall window with stars.
    r(g, x + w - 76, y - 8, 40, 7, 0x061018);
    r(g, x + w - 70, y - 6, 1, 1, 0xbfe6ff);
    r(g, x + w - 52, y - 4, 1, 1, 0x7f9fb0);
    r(g, x + w - 44, y - 7, 1, 1, 0xbfe6ff);
    // Workstation desk + monitor frame.
    const dx = x + w / 2 - 28;
    r(g, dx, y + 34, 56, 14, 0x3a2f28);
    r(g, dx, y + 34, 56, 2, 0x5a4a3c);
    r(g, dx + 2, y + 47, 4, 4, 0x2a221d);
    r(g, dx + 50, y + 47, 4, 4, 0x2a221d);
    r(g, x + w / 2 - 16, y + 14, 32, 20, 0x0e1418);
    r(g, x + w / 2 - 2, y + 33, 4, 2, 0x0e1418);
    r(g, dx + 16, y + 39, 24, 4, 0x1b2228); // keyboard
  }

  // Door frames.
  const door = (x: number, y: number, w: number, h: number) => {
    r(g, x, y, w, h, 0x2f4250);
    r(g, x + 1, y + 1, w - 2, h - 2, 0x1a252d);
  };
  door(310, 94, 12, 24);
  door(318, 94, 12, 24);
  door(310, 266, 12, 24);
  door(318, 266, 12, 24);
  door(234, 186, 28, 12);
  door(502, 186, 28, 12);

  // Room furniture.
  const cc = ROOMS[0];
  r(g, cc.x + 30, cc.y + 92, 44, 22, 0x1d2b24); // holo table
  r(g, cc.x + 34, cc.y + 95, 36, 16, 0x0f3a24);
  r(g, cc.x + 50, cc.y + 98, 4, 10, 0x2fbf71, 0.6);
  r(g, cc.x + 44, cc.y + 102, 16, 2, 0x2fbf71, 0.6);
  r(g, cc.x + 10, cc.y + 10, 36, 24, 0x0a1310); // star map
  for (const [px, py] of [[16, 16], [24, 22], [34, 14], [40, 26], [20, 28]]) r(g, cc.x + px, cc.y + py, 2, 2, 0x3cf58c, 0.7);
  r(g, cc.x + 230, cc.y + 110, 40, 34, 0x1b2228); // captain's chair area
  r(g, cc.x + 236, cc.y + 116, 28, 22, 0x26402f);

  const lab = ROOMS[1];
  r(g, lab.x + 16, lab.y + 104, 72, 14, 0x2a3640); // bench
  for (const [i, c] of [[0, 0x3fe0f0], [1, 0xff8fd0], [2, 0x9cff6b], [3, 0xffd36b]] as const) {
    r(g, lab.x + 22 + i * 16, lab.y + 96, 6, 8, 0xcfe8f0, 0.35);
    r(g, lab.x + 23 + i * 16, lab.y + 100, 4, 4, c, 0.85);
  }
  r(g, lab.x + lab.w - 40, lab.y + 8, 24, 64, 0x1a2229); // server rack body
  for (let i = 0; i < 6; i++) r(g, lab.x + lab.w - 37, lab.y + 12 + i * 10, 18, 7, 0x0f151a);

  const st = ROOMS[2];
  r(g, st.x + 10, st.y + 8, 44, 34, 0x2a2018); // bookshelf
  const spines = [0xc0574a, 0x4a8fc0, 0xd7b24a, 0x6fbf6a, 0xa070e0, 0xe08a4a];
  for (let i = 0; i < 12; i++) r(g, st.x + 13 + (i % 6) * 7, st.y + 11 + Math.floor(i / 6) * 15, 5, 12, spines[i % spines.length]);
  r(g, st.x + st.w - 64, st.y + 104, 40, 22, 0x2e3238); // printer
  r(g, st.x + st.w - 58, st.y + 100, 28, 6, 0xe8eef0);
  r(g, st.x + 40, st.y + 96, 26, 34, 0x3a2f28); // easel
  r(g, st.x + 43, st.y + 99, 20, 22, 0xe8e0d0);
  r(g, st.x + 46, st.y + 104, 14, 2, 0xa070e0);
  r(g, st.x + 46, st.y + 109, 10, 2, 0x8a7d70);

  const rv = ROOMS[3];
  r(g, rv.x + 24, rv.y + 84, 6, 52, 0x3a4a5a); // scanner arch
  r(g, rv.x + 62, rv.y + 84, 6, 52, 0x3a4a5a);
  r(g, rv.x + 24, rv.y + 80, 44, 6, 0x3a4a5a);
  r(g, rv.x + 30, rv.y + 86, 32, 2, 0x7aa2ff, 0.5);
  r(g, rv.x + rv.w - 60, rv.y + 8, 44, 30, 0x18202a); // checklist board
  for (let i = 0; i < 4; i++) {
    r(g, rv.x + rv.w - 56, rv.y + 12 + i * 6, 3, 3, 0x7aa2ff, 0.8);
    r(g, rv.x + rv.w - 50, rv.y + 13 + i * 6, 26, 1, 0x8aa0b8);
  }
}

interface RoomRuntime {
  room: RoomDef;
  crew: Sprite;
  icon: Sprite;
  light: Graphics;
  screen: Graphics;
  leds: Graphics | null;
  textures: ReturnType<typeof crewTextures>;
}

const LIGHT: Record<AgentVisualState, number> = {
  offline: 0x1a2228,
  idle: 0x1f5a3d,
  standby: 0x23302a,
  running: 0x3cf58c,
  awaiting_approval: 0xffb43c,
  failed: 0xff4f5e,
  complete: 0x3cf58c,
};

export interface SceneProps {
  agents: Agent[];
  offline: boolean;
}

export function StationScene({ agents, offline }: SceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<SceneProps>({ agents, offline });
  live.current = { agents, offline };
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const app = new Application();
    let ready = false;
    (async () => {
      try {
        await app.init({ width: SCENE_W, height: SCENE_H, antialias: false, background: 0x04070a, resolution: 1, preference: 'webgl' });
      } catch (err) {
        setFailed((err as Error).message);
        return;
      }
      if (disposed) {
        app.destroy(true);
        return;
      }
      ready = true;
      app.canvas.setAttribute('aria-hidden', 'true');
      host.current?.prepend(app.canvas);

      const stage = new Container();
      app.stage.addChild(stage);
      const base = new Graphics();
      drawStatic(base);
      stage.addChild(base);
      const icons = iconTextures();

      const rooms: RoomRuntime[] = ROOMS.map((room) => {
        const light = new Graphics();
        const screen = new Graphics();
        const leds = room.role === 'researcher' ? new Graphics() : null;
        const textures = crewTextures(room.role);
        const crew = new Sprite(textures.front);
        crew.scale.set(2);
        const icon = new Sprite(icons.alert);
        icon.scale.set(2);
        icon.visible = false;
        stage.addChild(light, screen, crew, icon);
        if (leds) stage.addChild(leds);
        return { room, crew, icon, light, screen, leds, textures };
      });

      let t = 0;
      app.ticker.add((ticker) => {
        t += ticker.deltaMS;
        const { agents: list, offline: down } = live.current;
        for (const rt of rooms) {
          const { room, crew, icon, light, screen, leds, textures } = rt;
          const agent = list.find((a) => a.role === room.role);
          const state: AgentVisualState = down ? 'offline' : agent?.state ?? 'offline';
          const cx = room.x + room.w / 2;
          const running = state === 'running';

          // Crew position and frame.
          if (running) {
            crew.texture = Math.floor(t / 180) % 2 ? textures.typeA : textures.typeB;
            crew.position.set(cx - 12, room.y + 46);
          } else {
            const blink = state !== 'offline' && state !== 'standby' && t % 3600 < 140;
            crew.texture = blink ? textures.blink : textures.front;
            const bob = state === 'offline' || state === 'standby' ? 0 : Math.round(Math.sin(t / 700));
            crew.position.set(cx + 44, room.y + 78 + bob);
          }
          crew.tint = state === 'offline' ? 0x3a4248 : state === 'standby' ? 0x7d8a84 : 0xffffff;

          // Status icon above the head.
          const iconFor: Partial<Record<AgentVisualState, keyof typeof icons>> = { awaiting_approval: 'alert', failed: 'fail', complete: 'done', standby: 'sleep' };
          const key = iconFor[state];
          icon.visible = !!key;
          if (key) {
            icon.texture = icons[key];
            const lift = state === 'awaiting_approval' ? Math.round(Math.sin(t / 250) * 2) : 0;
            icon.position.set(crew.x + 5, crew.y - 18 + lift);
          }

          // Room light strip on the back wall.
          light.clear();
          let alpha = 1;
          if (state === 'awaiting_approval') alpha = t % 1200 < 700 ? 1 : 0.35;
          else if (state === 'failed') alpha = 0.55 + 0.45 * Math.abs(Math.sin(t / 400));
          else if (running) alpha = 0.7 + 0.3 * Math.abs(Math.sin(t / 500));
          r(light, room.x + 8, room.y - 4, room.w - 100, 2, LIGHT[state], alpha);

          // Monitor: scrolling output only while work is confirmed running.
          screen.clear();
          const sx = cx - 14;
          const sy = room.y + 16;
          if (state === 'offline') {
            r(screen, sx, sy, 28, 16, 0x050708);
          } else {
            r(screen, sx, sy, 28, 16, running ? 0x062414 : 0x07130d);
            const accent = hex(CREW[room.role].accent);
            if (running) {
              const off = Math.floor(t / 120);
              for (let i = 0; i < 5; i++) {
                const len = 6 + ((off + i * 7) % 17);
                r(screen, sx + 2, sy + 2 + i * 3, Math.min(len, 24), 1, accent, 0.9);
              }
            } else {
              r(screen, sx + 2, sy + 2, 8, 1, accent, 0.35);
              if (state !== 'standby') r(screen, sx + 2, sy + 5, 2, 2, accent, Math.floor(t / 600) % 2 ? 0.5 : 0);
            }
          }

          // Research servers blink only during real work in the lab.
          if (leds) {
            leds.clear();
            for (let i = 0; i < 6; i++) {
              for (let j = 0; j < 3; j++) {
                const on = running && (Math.floor(t / 150) + i * 3 + j * 5) % 7 < 3;
                r(leds, room.x + room.w - 35 + j * 5, room.y + 14 + i * 10, 2, 2, on ? 0x3fe0f0 : state === 'offline' ? 0x0b0f12 : 0x1d3a40);
              }
            }
          }
        }
      });
    })();
    return () => {
      disposed = true;
      if (ready) app.destroy(true, { children: true });
    };
  }, []);

  return (
    <div className="scene" ref={host}>
      {failed && <div className="scene-error">Station view unavailable: {failed}. The panels below still show live state.</div>}
      {ROOMS.map((room) => {
        const agent = agents.find((a) => a.role === room.role);
        const state = offline ? 'offline' : agent?.state ?? 'offline';
        return (
          <div
            key={room.role}
            className={`room-plate state-${state}`}
            style={{ left: `${((room.x + 4) / SCENE_W) * 100}%`, top: `${((room.y + room.h - 18) / SCENE_H) * 100}%` }}
          >
            <span className="room-name">{room.name}</span>
            <span className="room-agent">{agent?.name ?? room.role}</span>
          </div>
        );
      })}
      {offline && (
        <div className="scene-offline" role="status">
          <strong>DISCONNECTED</strong>
          <span>Agent activity is not being shown because the backend link is down.</span>
        </div>
      )}
    </div>
  );
}
