// Shapes returned by the station API (server/src/state.ts).
export type TaskStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
export type AgentRole = 'commander' | 'researcher' | 'writer' | 'reviewer';
export type AgentVisualState = 'offline' | 'idle' | 'running' | 'awaiting_approval' | 'failed' | 'complete' | 'standby';
export type SourceType = 'wikipedia' | 'arxiv' | 'pypi' | 'github' | 'url';

export interface Health {
  connected: boolean;
  ready: boolean;
  checkedAt: string;
  detail: string;
}

export interface Task {
  id: number;
  label: string;
  title: string;
  description: string;
  status: TaskStatus;
  stage: string | null;
  assignedAgent: string | null;
  dependsOn: number[];
  project: string | null;
  outputPath: string | null;
  approvalRequired: boolean;
  error: string | null;
  errorDetail: string | null;
  revisions: number;
  tokensTotal: number;
  costUsd: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Agent {
  role: AgentRole;
  name: string;
  room: string;
  openclawAgentId: string;
  state: AgentVisualState;
  detail: string;
  taskId: number | null;
}

export interface Approval {
  id: number;
  taskId: number;
  taskLabel: string;
  kind: 'final_report' | 'external_action' | 'clarification';
  payload: any;
  createdAt: string;
}

export interface Action {
  id: number;
  taskId: number;
  taskLabel: string;
  kind: string;
  target: string;
  status: string;
  result: any;
  updatedAt: string;
}

export interface StationEvent {
  id: number;
  ts: string;
  taskId: number | null;
  taskLabel: string | null;
  agent: string | null;
  type: string;
  message: string;
}

export interface Limits {
  dailyTokenCap: number;
  perTaskTokenCap: number;
  dailyUsdLimit: number;
}

export interface UsageSummary {
  day: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  callsWithoutUsage: number;
  outputChars: number;
  outputTokensNote: string;
  costUsd: number | null;
  costAvailable: boolean;
  costNote: string;
  limits: Limits;
  blocked: boolean;
  blockReason: string | null;
}

export interface StationState {
  mode: 'real' | 'demo';
  serverTime: string;
  gateway: Health;
  queue: {
    paused: boolean;
    block: string | null;
    maxWorkers: number;
    runningSteps: number;
    queuedSteps: number;
    teamMode: 'solo' | 'team';
    counts: Partial<Record<TaskStatus, number>>;
  };
  usage: UsageSummary;
  agents: Agent[];
  tasks: Task[];
  approvals: Approval[];
  actions: Action[];
  events: StationEvent[];
  settings: { approvedDomains: string[]; timezone: string; webhookAllowlist: string[] };
}

export interface Step {
  id: number;
  stage: string;
  agent: string;
  executor: 'openclaw' | 'station';
  status: string;
  attempt: number;
  maxAttempts: number;
  timeoutMs: number;
  error: string | null;
  output: any;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number } | null;
  tokensTotal: number;
  openclawResponseId: string | null;
  memorySha256: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Source {
  id: number;
  ref: string;
  type: string;
  url: string;
  title: string;
  retrievedAt: string;
  sha256: string;
  bytes: number;
  chars: number;
}

export interface TaskDetail {
  task: Task;
  request: { description: string; project: string | null; urls: string[]; sourceTypes: SourceType[]; clarifications?: { question: string; answer: string }[] };
  steps: Step[];
  sources: Source[];
  approvals: (Omit<Approval, 'taskId' | 'taskLabel'> & { status: string; note: string | null; decidedAt: string | null })[];
  actions: { id: number; kind: string; target: string; status: string; result: any }[];
  events: { id: number; ts: string; agent: string | null; type: string; message: string }[];
  draft: string | null;
  output: string | null;
}
