import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Express, Request, Response } from 'express';
import type { AgentConfig, Proposal, DissentCondition } from './types.js';
import { generateId } from './protocol.js';
import type { JournalStore } from './journal.js';
import { evaluate } from './evaluator.js';

/**
 * Registers ADP/ADJ tools on an McpServer instance.
 * Called per-request in stateless mode.
 */
function registerTools(mcpServer: McpServer, config: AgentConfig, journal: JournalStore): void {
  // The SDK's overloaded tool() signatures trigger "type instantiation is
  // excessively deep" errors in TypeScript's inference when called with
  // full Zod schemas. Narrow to a minimal call shape here — runtime
  // behavior is unchanged, we just skip TS's overload resolution.
  const mcp = mcpServer as unknown as {
    tool: (name: string, description: string, schema: Record<string, unknown>, cb: (args: any) => any) => unknown;
  };

  mcp.tool('adp_propose', 'Request a proposal from this agent for a deliberation', {
    deliberationId: z.string(), actionKind: z.string(), actionTarget: z.string(),
    actionParameters: z.record(z.string()).optional(),
    reversibilityTier: z.enum(['reversible', 'partially_reversible', 'irreversible']).optional(),
  }, async ({ deliberationId, actionKind, actionTarget, actionParameters, reversibilityTier }) => {
    const action = { kind: actionKind, target: actionTarget, parameters: actionParameters };
    const domain = config.decisionClasses[0];
    const evalResult = await evaluate(config.evaluator, action, {
      agentId: config.agentId,
      decisionClass: domain,
    });
    const vote = evalResult?.vote ?? config.defaultVote;
    const confidence = evalResult?.confidence ?? config.defaultConfidence;
    const conditionStrings = evalResult?.dissentConditions?.length ? evalResult.dissentConditions : config.dissentConditions;
    const conditions: DissentCondition[] = conditionStrings.map((cond, i) => ({
      id: `dc_${config.agentId.split(':').pop()}_${String(i + 1).padStart(2, '0')}`,
      condition: cond, status: 'active', amendments: [], testedInRound: null, testedBy: null,
    }));
    const proposal: Proposal = {
      proposalId: generateId('prp'), deliberationId, agentId: config.agentId,
      timestamp: new Date().toISOString(), action,
      vote, confidence,
      domainClaim: { domain, authoritySource: `mcp-manifest:${config.agentId}#authorities` },
      reversibilityTier: reversibilityTier || 'partially_reversible',
      blastRadius: { scope: [actionTarget], estimatedUsersAffected: 0, rollbackCostSeconds: 60 },
      justification: { summary: evalResult?.summary ?? `Evaluation by ${config.agentId}`, evidenceRefs: evalResult?.evidenceRefs ?? [] },
      stake: { declaredBy: 'self', magnitude: config.stakeMagnitude, calibrationAtStake: true },
      dissentConditions: conditions, revisions: [],
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(proposal) }] };
  });

  mcp.tool('adp_falsify', 'Submit falsification evidence against a dissent condition', {
    conditionId: z.string(), round: z.number(), evidenceAgentId: z.string(),
  }, async ({ conditionId, round, evidenceAgentId }) => {
    const response = config.falsificationResponses[conditionId] || 'acknowledge';
    const result = response === 'acknowledge'
      ? { action: 'acknowledge', conditionId, round, reviseVote: 'abstain', reason: `Condition ${conditionId} falsified by ${evidenceAgentId}.` }
      : { action: 'reject', conditionId, round, reason: `Evidence insufficient to falsify ${conditionId}.` };
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  });

  mcp.tool('adj_calibration', 'Query calibration score for an agent in a domain', {
    agentId: z.string().optional(), domain: z.string().optional(),
  }, async ({ agentId, domain }) => {
    const cal = journal.getCalibration(agentId || config.agentId, domain || config.decisionClasses[0]);
    return { content: [{ type: 'text' as const, text: JSON.stringify(cal) }] };
  });

  mcp.tool('adj_journal', 'Retrieve journal entries for a deliberation', {
    deliberationId: z.string(),
  }, async ({ deliberationId }) => {
    return { content: [{ type: 'text' as const, text: JSON.stringify(journal.getDeliberation(deliberationId)) }] };
  });

  mcp.tool('adj_outcome', 'Get the outcome for a deliberation', {
    deliberationId: z.string(),
  }, async ({ deliberationId }) => {
    return { content: [{ type: 'text' as const, text: JSON.stringify(journal.getOutcome(deliberationId)) }] };
  });

  mcp.tool('adj_append_entries', 'Append journal entries (peer gossip)', {
    entries: z.string().describe('JSON-encoded array of JournalEntry objects'),
  }, async ({ entries }) => {
    const parsed = JSON.parse(entries);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    journal.appendBatch(arr);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ written: arr.length }) }] };
  });
}

/**
 * Mounts MCP Streamable HTTP endpoints on Express at /mcp.
 * Stateless mode: new McpServer + transport per request.
 */
export function mountMcpEndpoints(app: Express, config: AgentConfig, journal: JournalStore): void {
  const createServer = () => {
    const mcp = new McpServer(
      { name: `adp-agent-${config.agentId}`, version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    registerTools(mcp, config, journal);
    return mcp;
  };

  app.post('/mcp', async (req: Request, res: Response) => {
    const mcp = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const mcp = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', (_req: Request, res: Response) => {
    res.status(405).end();
  });
}

// Re-export for backward compatibility
export const createMcpServer = mountMcpEndpoints;
