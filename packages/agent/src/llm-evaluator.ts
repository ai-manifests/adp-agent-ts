/**
 * LLM evaluator — calls Anthropic or OpenAI with structured-output forcing
 * to produce a guaranteed-shape `EvaluationResult`.
 *
 * Anthropic uses tool_use forced output (`tool_choice: { type: "tool" }`),
 * which is the supported pattern for guaranteed JSON; the system prompt is
 * marked as cacheable so the same prompt across actions hits the cache.
 *
 * OpenAI uses Structured Outputs (response_format: json_schema, strict: true).
 *
 * Provider keys come from process.env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`)
 * — not config — to keep them out of the agent JSON config.
 */
import type {
  EvaluatorConfig,
  EvaluationResult,
  EvaluatorAgentContext,
  Vote,
} from './types.js';

const VOTE_SCHEMA = {
  type: 'object',
  properties: {
    vote: { type: 'string', enum: ['approve', 'reject', 'abstain'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
    dissent_conditions: { type: 'array', items: { type: 'string' } },
    evidence_refs: { type: 'array', items: { type: 'string' } },
  },
  required: ['vote', 'confidence', 'summary', 'dissent_conditions', 'evidence_refs'],
  additionalProperties: false,
} as const;

export interface LlmAction {
  kind: string;
  target: string;
  parameters?: Record<string, string>;
}

export async function evaluateLlm(
  config: EvaluatorConfig,
  action: LlmAction,
  context: EvaluatorAgentContext,
): Promise<EvaluationResult> {
  const provider = config.provider;
  if (provider !== 'anthropic' && provider !== 'openai') {
    return fallback(`llm evaluator: unsupported provider '${provider ?? '<missing>'}'`);
  }
  if (!config.model) return fallback('llm evaluator: model is required');
  if (!config.systemPrompt) return fallback('llm evaluator: systemPrompt is required');
  if (!config.userTemplate) return fallback('llm evaluator: userTemplate is required');

  const userMessage = renderTemplate(config.userTemplate, action, context);
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxTokens = config.maxTokens ?? 1024;
  const temperature = config.temperature ?? 0;

  try {
    if (provider === 'anthropic') {
      return await callAnthropic(config, userMessage, { timeoutMs, maxTokens, temperature });
    }
    return await callOpenAi(config, userMessage, { timeoutMs, maxTokens, temperature });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fallback(`llm evaluator (${provider}) failed: ${message}`);
  }
}

interface CallOptions {
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

async function callAnthropic(
  config: EvaluatorConfig,
  userMessage: string,
  opts: CallOptions,
): Promise<EvaluationResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in environment');

  const body = {
    model: config.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    system: [{ type: 'text', text: config.systemPrompt!, cache_control: { type: 'ephemeral' } }],
    tools: [{
      name: 'submit_vote',
      description: 'Submit your judgement on this action with confidence and dissent conditions.',
      input_schema: VOTE_SCHEMA,
    }],
    tool_choice: { type: 'tool', name: 'submit_vote' },
    messages: [{ role: 'user', content: userMessage }],
  };

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, opts.timeoutMs);

  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`anthropic ${res.status}: ${text.slice(0, 240)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; input?: unknown }> };
  const toolUse = (data.content ?? []).find(c => c.type === 'tool_use');
  if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
    throw new Error('anthropic: response had no tool_use block');
  }
  return shapeFromRaw(toolUse.input as Record<string, unknown>);
}

async function callOpenAi(
  config: EvaluatorConfig,
  userMessage: string,
  opts: CallOptions,
): Promise<EvaluationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set in environment');

  const body = {
    model: config.model,
    temperature: opts.temperature,
    max_completion_tokens: opts.maxTokens,
    messages: [
      { role: 'system', content: config.systemPrompt! },
      { role: 'user', content: userMessage },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'submit_vote', schema: VOTE_SCHEMA, strict: true },
    },
  };

  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }, opts.timeoutMs);

  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`openai ${res.status}: ${text.slice(0, 240)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('openai: response had no content');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`openai: response was not valid JSON: ${content.slice(0, 240)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('openai: parsed content is not an object');
  }
  return shapeFromRaw(parsed as Record<string, unknown>);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function renderTemplate(
  template: string,
  action: LlmAction,
  context: EvaluatorAgentContext,
): string {
  const params = action.parameters
    ? Object.entries(action.parameters).map(([k, v]) => `${k}=${v}`).join(', ')
    : '';
  return template
    .replaceAll('{action.kind}', action.kind)
    .replaceAll('{action.target}', action.target)
    .replaceAll('{action.parameters}', params)
    .replaceAll('{agent.id}', context.agentId)
    .replaceAll('{agent.decisionClass}', context.decisionClass);
}

function shapeFromRaw(raw: Record<string, unknown>): EvaluationResult {
  const vote = normaliseVote(raw.vote);
  const confidence = clamp(typeof raw.confidence === 'number' ? raw.confidence : 0.5, 0, 1);
  const summary = typeof raw.summary === 'string' ? raw.summary : '';
  const dissentConditions = Array.isArray(raw.dissent_conditions)
    ? raw.dissent_conditions.filter((x): x is string => typeof x === 'string')
    : [];
  const evidenceRefs = Array.isArray(raw.evidence_refs)
    ? raw.evidence_refs.filter((x): x is string => typeof x === 'string')
    : [];
  return { vote, confidence, summary, dissentConditions, evidenceRefs };
}

function normaliseVote(value: unknown): Vote {
  if (value === 'approve' || value === 'reject' || value === 'abstain') return value;
  return 'abstain';
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function fallback(summary: string): EvaluationResult {
  return { vote: 'abstain', confidence: 0.5, summary, evidenceRefs: [], dissentConditions: [] };
}
