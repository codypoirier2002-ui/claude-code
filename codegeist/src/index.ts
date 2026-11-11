/**
 * Forge function entry points. `manifest.yml` maps each `function` module to
 * one of these exports.
 */
import {
  checkIssueReadiness as checkIssueReadinessAction,
  getContextPack as getContextPackAction,
  listReadyIssues as listReadyIssuesAction,
  type ActionPayload,
  type InvocationContext,
} from './actions';

export { handler as resolver } from './resolvers';

export const checkIssueReadiness = (payload: ActionPayload, context?: InvocationContext) =>
  checkIssueReadinessAction(payload, context);

export const getContextPack = (payload: ActionPayload, context?: InvocationContext) =>
  getContextPackAction(payload, context);

export const listReadyIssues = (payload: ActionPayload, context?: InvocationContext) =>
  listReadyIssuesAction(payload, context);
