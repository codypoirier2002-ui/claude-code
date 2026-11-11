import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  CodeBlock,
  Heading,
  Inline,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  ProgressBar,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  User,
  xcss,
} from '@forge/react';
import { events, invoke, rovo } from '@forge/bridge';
import type { Check, CheckStatus, Verdict } from '../core/types';
import type { PanelError, PanelModel } from '../resolvers';
import { AGENT, rovoPrompt } from './agent';

const VERDICT_APPEARANCE: Record<Verdict, 'success' | 'moved' | 'removed'> = {
  ready: 'success',
  almost: 'moved',
  'not-ready': 'removed',
  blocked: 'removed',
};

const STATUS_LOZENGE: Record<Exclude<CheckStatus, 'na'>, { text: string; appearance: 'success' | 'moved' | 'removed' }> =
  {
    pass: { text: 'OK', appearance: 'success' },
    warn: { text: 'Check', appearance: 'moved' },
    fail: { text: 'Gap', appearance: 'removed' },
  };

const STATUS_ORDER: Record<CheckStatus, number> = { fail: 0, warn: 1, pass: 2, na: 3 };

const LOAD_ERROR = 'Groundwork could not load the ready check. Refresh to try again.';

const rowStyle = xcss({
  paddingBlock: 'space.075',
  borderBottomWidth: 'border.width',
  borderBottomStyle: 'solid',
  borderBottomColor: 'color.border',
});

const lozengeColumn = xcss({ minWidth: '52px' });

function isError(value: PanelModel | PanelError): value is PanelError {
  return typeof (value as PanelError).error === 'string';
}

function countLabel(count: number, noun: string): string {
  return count > 0 ? `${count} ${noun}${count === 1 ? '' : 's'}` : '';
}

function CheckRow({ check }: { check: Check }) {
  const status = check.status === 'na' ? undefined : STATUS_LOZENGE[check.status];
  return (
    <Box xcss={rowStyle}>
      <Inline space="space.100" alignBlock="start">
        <Box xcss={lozengeColumn}>
          {status ? <Lozenge appearance={status.appearance}>{status.text}</Lozenge> : null}
        </Box>
        <Stack space="space.025">
          <Text weight="semibold">{check.label}</Text>
          <Text size="small">{check.detail}</Text>
          {check.fix ? <Text size="small" color="color.text.subtle">{`Fix: ${check.fix}`}</Text> : null}
        </Stack>
      </Inline>
    </Box>
  );
}

function ReadyCheck({ model, refreshing, onRefresh }: { model: PanelModel; refreshing: boolean; onRefresh: () => void }) {
  const [packOpen, setPackOpen] = useState(false);
  const [rovoAvailable, setRovoAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    rovo
      .isEnabled()
      .then((enabled) => {
        if (active) setRovoAvailable(enabled);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const checks = model.checks
    .filter((c) => c.status !== 'na')
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.weight - a.weight);
  const notChecked = model.checks.filter((c) => c.status === 'na').map((c) => c.label);
  const graphCounts = [
    countLabel(model.graph.goals, 'goal'),
    countLabel(model.graph.pullRequests, 'pull request'),
    countLabel(model.graph.pageOwners, 'page owner'),
    countLabel(model.graph.teams, 'team'),
  ].filter((part) => part.length > 0);

  return (
    <Stack space="space.200">
      <Stack space="space.100">
        <Inline spread="space-between" alignBlock="center">
          <Lozenge appearance={VERDICT_APPEARANCE[model.verdict]} isBold>
            {model.verdictLabel}
          </Lozenge>
          <Inline space="space.075" alignBlock="center">
            {refreshing ? <Spinner size="small" label="Re-checking" /> : null}
            <Heading size="small">{`${model.score}/100`}</Heading>
          </Inline>
        </Inline>
        <ProgressBar
          value={model.score / 100}
          appearance={model.verdict === 'ready' ? 'success' : 'default'}
          ariaLabel={`Readiness ${model.score} out of 100`}
        />
      </Stack>

      <Stack space="space.0">
        {checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
        {notChecked.length > 0 ? (
          <Box paddingBlockStart="space.075">
            <Text size="small" color="color.text.subtlest">{`Not checked: ${notChecked.join(', ')}.`}</Text>
          </Box>
        ) : null}
      </Stack>

      {model.people.length > 0 ? (
        <Stack space="space.100">
          <Heading size="xsmall">People to ask</Heading>
          {model.people.map((person) => (
            <Stack key={person.accountId ?? person.name} space="space.025">
              {person.accountId ? <User accountId={person.accountId} /> : <Text weight="semibold">{person.name}</Text>}
              <Text size="small" color="color.text.subtle">
                {person.reasons.join('; ')}
              </Text>
            </Stack>
          ))}
        </Stack>
      ) : null}

      <Text size="small" color="color.text.subtlest">
        {graphCounts.length > 0
          ? `Teamwork Graph: ${graphCounts.join(', ')}.`
          : `Teamwork Graph: ${model.graph.note}`}
      </Text>

      <Inline space="space.100" shouldWrap>
        {rovoAvailable ? (
          <Button appearance="rovo" onClick={() => void rovo.open({ ...AGENT, prompt: rovoPrompt(model) })}>
            {model.verdict === 'ready' ? 'Hand off with Rovo' : 'Fix with Rovo'}
          </Button>
        ) : null}
        <Button appearance={rovoAvailable ? 'default' : 'primary'} onClick={() => setPackOpen(true)}>
          View context pack
        </Button>
        <Button appearance="subtle" onClick={onRefresh} isDisabled={refreshing}>
          Refresh
        </Button>
      </Inline>

      <ModalTransition>
        {packOpen ? (
          <Modal onClose={() => setPackOpen(false)} width="x-large">
            <ModalHeader>
              <ModalTitle>{`Context pack for ${model.issueKey}`}</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.150">
                <Text>
                  Copy this brief into a hand-off, or let agents fetch it themselves: the Groundwork agent in Rovo
                  and any MCP client can call get-context-pack.
                </Text>
                <CodeBlock text={model.pack} language="markdown" showLineNumbers={false} shouldWrapLongLines />
              </Stack>
            </ModalBody>
            <ModalFooter>
              <Button appearance="primary" onClick={() => setPackOpen(false)}>
                Close
              </Button>
            </ModalFooter>
          </Modal>
        ) : null}
      </ModalTransition>
    </Stack>
  );
}

function App() {
  const [model, setModel] = useState<PanelModel | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Without invoke metadata, the resolver's return value comes back unwrapped.
      const result = (await invoke<PanelModel | PanelError>('getReadyCheck')) as PanelModel | PanelError;
      if (isError(result)) {
        setError(result.error);
      } else {
        setModel(result);
        setError(undefined);
      }
    } catch {
      setError(LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-run the check after someone edits or comments on the work item.
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    events
      .on('JIRA_ISSUE_CHANGED', () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void load(), 1500);
      })
      .then((subscription) => {
        if (active) unsubscribe = () => subscription.unsubscribe();
        else subscription.unsubscribe();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [load]);

  if (!model && loading) {
    return (
      <Inline space="space.100" alignBlock="center">
        <Spinner size="medium" label="Checking readiness" />
        <Text>Checking readiness…</Text>
      </Inline>
    );
  }

  return (
    <Stack space="space.150">
      {error ? (
        <SectionMessage appearance="warning" title={model ? 'Could not refresh the ready check' : 'Ready check unavailable'}>
          <Text>{error}</Text>
          <Button appearance="subtle" onClick={() => void load()}>
            Try again
          </Button>
        </SectionMessage>
      ) : null}
      {model ? <ReadyCheck model={model} refreshing={loading} onRefresh={() => void load()} /> : null}
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
