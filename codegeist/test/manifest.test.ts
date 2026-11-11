/**
 * Checks manifest.yml and the skill folders against the rules in the Forge
 * module reference, so mistakes show up here instead of at `forge deploy`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

vi.mock('@forge/api', () => ({ default: { asUser: () => ({}) }, route: () => '' }));
vi.mock('@forge/resolver', () => ({
  default: class {
    define(): void {}
    getDefinitions(): () => undefined {
      return () => undefined;
    }
  },
}));

const root = fileURLToPath(new URL('..', import.meta.url));

interface ActionInput {
  title?: string;
  type?: string;
  required?: boolean;
  description?: string;
}
interface Manifest {
  modules: {
    'jira:issueContext': { key: string; resource: string; resolver: { function: string }; render: string; title: string; label: string }[];
    'rovo:agent': { key: string; name: string; prompt: string; actions: string[]; skills: string[]; conversationStarters: string[] }[];
    'rovo:skill': { key: string; source: { dir: string }; dependencies?: { tools: string[] } }[];
    'rovo:mcp': { key: string; name: string; tools: string[] }[];
    action: { key: string; name: string; function: string; actionVerb: string; description: string; inputs: Record<string, ActionInput> }[];
    function: { key: string; handler: string }[];
  };
  resources: { key: string; path: string }[];
  permissions: { scopes: string[] };
  app: { id: string; runtime: { name: string } };
}

const manifest = parse(readFileSync(join(root, 'manifest.yml'), 'utf8')) as Manifest;
const { modules } = manifest;
const actionKeys = new Set(modules.action.map((a) => a.key));
const functionKeys = new Set(modules.function.map((f) => f.key));
const resourceKeys = new Set(manifest.resources.map((r) => r.key));

function readSkill(dir: string): { front: Record<string, unknown>; body: string } {
  const raw = readFileSync(join(root, dir, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${dir}/SKILL.md has no YAML frontmatter`);
  return { front: parse(match[1]) as Record<string, unknown>, body: match[2] };
}

describe('manifest modules', () => {
  it('declares unique module keys', () => {
    const keys = Object.values(modules).flatMap((list) => (list as { key: string }[]).map((m) => m.key));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('wires every action to a function and documents every input', () => {
    expect(modules.action.length).toBeLessThanOrEqual(50);
    for (const action of modules.action) {
      expect(action.key.length, action.key).toBeLessThan(64);
      expect(functionKeys.has(action.function), action.key).toBe(true);
      expect(['GET', 'CREATE', 'UPDATE', 'DELETE', 'TRIGGER']).toContain(action.actionVerb);
      expect(action.actionVerb, `${action.key} must stay read-only`).toBe('GET');
      expect(action.description.length).toBeGreaterThan(50);
      for (const [name, input] of Object.entries(action.inputs)) {
        expect(input.title, `${action.key}.${name}`).toBeTruthy();
        expect(['string', 'integer', 'number', 'boolean']).toContain(input.type);
        expect(typeof input.required, `${action.key}.${name}`).toBe('boolean');
        expect(input.description, `${action.key}.${name}`).toBeTruthy();
      }
    }
  });

  it('points the agent at existing actions, skills and prompt resource', () => {
    const [agent] = modules['rovo:agent'];
    expect(agent.name.length).toBeLessThanOrEqual(30);
    for (const action of agent.actions) expect(actionKeys.has(action), action).toBe(true);
    const skillKeys = new Set(modules['rovo:skill'].map((s) => s.key));
    for (const skill of agent.skills) expect(skillKeys.has(skill), skill).toBe(true);
    expect(agent.conversationStarters.length).toBeGreaterThan(0);
    const reference = agent.prompt.match(/^resource:([^;]+);(.+)$/);
    expect(reference, 'prompt must be a resource reference').toBeTruthy();
    const [, resourceKey, file] = reference ?? [];
    const resource = manifest.resources.find((r) => r.key === resourceKey);
    expect(resource, resourceKey).toBeTruthy();
    expect(existsSync(join(root, resource?.path ?? '', file ?? ''))).toBe(true);
  });

  it('opens the same agent from the panel that the manifest declares', async () => {
    const { AGENT, rovoPrompt } = await import('../src/frontend/agent');
    const [agent] = modules['rovo:agent'];
    expect(AGENT.agentKey).toBe(agent.key);
    expect(AGENT.agentName).toBe(agent.name);
    expect(rovoPrompt({ issueKey: 'KAN-1', verdict: 'ready' })).toContain('context pack');
    expect(rovoPrompt({ issueKey: 'KAN-1', verdict: 'blocked' })).toContain('blocking KAN-1');
    expect(rovoPrompt({ issueKey: 'KAN-1', verdict: 'almost' })).toContain('ready to start');
  });

  it('exposes the actions as MCP tools within the module limits', () => {
    expect(modules['rovo:mcp']).toHaveLength(1);
    const [mcp] = modules['rovo:mcp'];
    expect(mcp.name.length).toBeLessThanOrEqual(30);
    expect(mcp.tools.length).toBeGreaterThan(0);
    for (const tool of mcp.tools) expect(actionKeys.has(tool), tool).toBe(true);
  });

  it('renders the issue context panel with UI Kit and an existing resolver', () => {
    const [panel] = modules['jira:issueContext'];
    expect(panel.render).toBe('native');
    expect(resourceKeys.has(panel.resource)).toBe(true);
    expect(functionKeys.has(panel.resolver.function)).toBe(true);
    expect(panel.title && panel.label).toBeTruthy();
  });

  it('points every resource at a file or folder that exists', () => {
    for (const resource of manifest.resources) {
      expect(existsSync(join(root, resource.path)), resource.path).toBe(true);
    }
    const main = manifest.resources.find((r) => r.key === 'main');
    expect(statSync(join(root, main?.path ?? '')).isFile()).toBe(true);
  });

  it('exports every function handler from src/index.ts', async () => {
    const entry = (await import('../src/index')) as Record<string, unknown>;
    for (const fn of modules.function) {
      const [file, name] = fn.handler.split('.');
      expect(file, fn.key).toBe('index');
      expect(typeof entry[name], fn.handler).toBe('function');
    }
  });
});

describe('permissions and runtime', () => {
  it('requests read-only scopes, including every Teamwork Graph object the queries read', () => {
    const scopes = new Set(manifest.permissions.scopes);
    for (const scope of scopes) expect(scope.startsWith('read:'), scope).toBe(true);
    for (const needed of [
      'read:jira-work',
      'read:graph:issue:jira', // JiraWorkItem: goals and pull requests start here
      'read:graph:goal:atlassian', // AtlassianGoal
      'read:graph:pull-request:external', // ExternalPullRequest
      'read:graph:page:confluence', // ConfluencePage: owners and contributors start here
      'read:graph:user:atlassian', // AtlassianUser
      'read:graph:project:jira', // JiraSpace: teams start here
      'read:graph:team:atlassian', // AtlassianTeam
    ]) {
      expect(scopes.has(needed), needed).toBe(true);
    }
    expect(scopes.size).toBeLessThanOrEqual(50);
  });

  it('runs on a supported Node runtime and keeps the placeholder app ID until registration', () => {
    expect(manifest.app.runtime.name).toBe('nodejs24.x');
    expect(manifest.app.id).toMatch(/^ari:cloud:ecosystem::app\/[0-9a-f-]{36}$/);
  });
});

describe('rovo:skill folders', () => {
  it('match the Agent Skills format Forge validates', () => {
    for (const skill of modules['rovo:skill']) {
      const dir = skill.source.dir;
      const { front, body } = readSkill(dir);
      expect(front.name).toBe(basename(dir));
      expect(String(front.name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      const description = String(front.description);
      expect(description.length).toBeGreaterThanOrEqual(50);
      expect(description.length).toBeLessThanOrEqual(1024);
      const allowed = String(front['allowed-tools'] ?? '').split(/\s+/).filter(Boolean);
      for (const tool of skill.dependencies?.tools ?? []) {
        expect(actionKeys.has(tool), tool).toBe(true);
        expect(allowed, `allowed-tools must include ${tool}`).toContain(tool);
      }
      expect(body.split('\n').length).toBeLessThanOrEqual(500);
      for (const value of Object.values((front.metadata as Record<string, unknown>) ?? {})) {
        expect(typeof value).toBe('string');
      }
    }
  });
});

describe('open-source skill for third-party agents', () => {
  it('is a valid skill that only names tools the MCP module exposes', () => {
    const dir = 'agent-skills/groundwork-pickup';
    const { front, body } = readSkill(dir);
    expect(front.name).toBe(basename(dir));
    expect(String(front.description).length).toBeLessThanOrEqual(1024);
    const mcpTools = new Set(modules['rovo:mcp'][0].tools);
    const mentioned = [...body.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]).filter((name) => name.includes('-'));
    const toolNames = mentioned.filter((name) => /(issue|context|ready)/.test(name) && name !== 'groundwork-pickup');
    expect(toolNames.length).toBeGreaterThan(0);
    for (const tool of toolNames) expect(mcpTools.has(tool), tool).toBe(true);
  });
});
