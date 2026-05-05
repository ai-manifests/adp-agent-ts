import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evaluateLlm, renderTemplate } from '../src/llm-evaluator.js';

describe('renderTemplate', () => {
  it('substitutes all five placeholders', () => {
    const out = renderTemplate(
      'Action {action.kind} on {action.target} with {action.parameters}; you are {agent.id} judging {agent.decisionClass}.',
      { kind: 'merge_pull_request', target: 'foo/bar#1', parameters: { branch: 'main' } },
      { agentId: 'did:adp:claude-tester-v1', decisionClass: 'code.correctness' },
    );
    expect(out).toBe(
      'Action merge_pull_request on foo/bar#1 with branch=main; you are did:adp:claude-tester-v1 judging code.correctness.',
    );
  });

  it('handles missing parameters as empty string', () => {
    const out = renderTemplate(
      '{action.parameters}',
      { kind: 'merge_pull_request', target: 'foo/bar#1' },
      { agentId: 'x', decisionClass: 'y' },
    );
    expect(out).toBe('');
  });

  it('replaces all occurrences when placeholder appears multiple times', () => {
    const out = renderTemplate(
      '{action.target} - {action.target}',
      { kind: 'k', target: 't' },
      { agentId: 'x', decisionClass: 'y' },
    );
    expect(out).toBe('t - t');
  });
});

describe('evaluateLlm — config validation', () => {
  it('returns abstain fallback when provider is missing', async () => {
    const r = await evaluateLlm(
      { kind: 'llm', model: 'm', systemPrompt: 's', userTemplate: 'u' } as any,
      { kind: 'merge_pull_request', target: 't' },
      { agentId: 'a', decisionClass: 'c' },
    );
    expect(r.vote).toBe('abstain');
    expect(r.summary).toMatch(/unsupported provider/);
  });

  it('returns abstain fallback when systemPrompt is missing', async () => {
    const r = await evaluateLlm(
      { kind: 'llm', provider: 'anthropic', model: 'm', userTemplate: 'u' } as any,
      { kind: 'k', target: 't' },
      { agentId: 'a', decisionClass: 'c' },
    );
    expect(r.vote).toBe('abstain');
    expect(r.summary).toMatch(/systemPrompt is required/);
  });
});

describe('evaluateLlm — Anthropic happy path with tool_use response', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('parses tool_use block into a typed EvaluationResult', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [
        { type: 'text', text: 'thinking out loud...' },
        {
          type: 'tool_use',
          name: 'submit_vote',
          input: {
            vote: 'reject',
            confidence: 0.91,
            summary: 'Tests are missing for the new branch.',
            dissent_conditions: ['no test added', 'missing changelog'],
            evidence_refs: ['ci.log'],
          },
        },
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await evaluateLlm(
      {
        kind: 'llm',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        systemPrompt: 'You evaluate code correctness.',
        userTemplate: 'Vote on {action.target}',
      },
      { kind: 'merge_pull_request', target: 'foo/bar#5' },
      { agentId: 'did:adp:claude-tester-v1', decisionClass: 'code.correctness' },
    );

    expect(result).toEqual({
      vote: 'reject',
      confidence: 0.91,
      summary: 'Tests are missing for the new branch.',
      dissentConditions: ['no test added', 'missing changelog'],
      evidenceRefs: ['ci.log'],
    });

    const call = (global.fetch as any).mock.calls[0];
    expect(call[0]).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(call[1].body);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_vote' });
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[0].content).toBe('Vote on foo/bar#5');
  });

  it('falls back when no tool_use block is returned', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'I refuse.' }],
    }), { status: 200 })) as unknown as typeof fetch;

    const r = await evaluateLlm(
      { kind: 'llm', provider: 'anthropic', model: 'm', systemPrompt: 's', userTemplate: 'u' },
      { kind: 'k', target: 't' },
      { agentId: 'a', decisionClass: 'c' },
    );
    expect(r.vote).toBe('abstain');
    expect(r.summary).toMatch(/no tool_use block/);
  });

  it('falls back on HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })) as unknown as typeof fetch;

    const r = await evaluateLlm(
      { kind: 'llm', provider: 'anthropic', model: 'm', systemPrompt: 's', userTemplate: 'u' },
      { kind: 'k', target: 't' },
      { agentId: 'a', decisionClass: 'c' },
    );
    expect(r.vote).toBe('abstain');
    expect(r.summary).toMatch(/anthropic 429/);
  });

  it('returns explicit fallback when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await evaluateLlm(
      { kind: 'llm', provider: 'anthropic', model: 'm', systemPrompt: 's', userTemplate: 'u' },
      { kind: 'k', target: 't' },
      { agentId: 'a', decisionClass: 'c' },
    );
    expect(r.vote).toBe('abstain');
    expect(r.summary).toMatch(/ANTHROPIC_API_KEY/);
  });
});

describe('evaluateLlm — OpenAI happy path with structured output', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it('parses message.content JSON into a typed EvaluationResult', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        vote: 'approve',
        confidence: 0.78,
        summary: 'Looks good',
        dissent_conditions: [],
        evidence_refs: [],
      }) } }],
    }), { status: 200 })) as unknown as typeof fetch;

    const r = await evaluateLlm(
      { kind: 'llm', provider: 'openai', model: 'gpt-5', systemPrompt: 's', userTemplate: 'u' },
      { kind: 'k', target: 't' },
      { agentId: 'a', decisionClass: 'c' },
    );

    expect(r.vote).toBe('approve');
    expect(r.confidence).toBe(0.78);

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it('falls back when content is not valid JSON', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'not json' } }],
    }), { status: 200 })) as unknown as typeof fetch;

    const r = await evaluateLlm(
      { kind: 'llm', provider: 'openai', model: 'gpt-5', systemPrompt: 's', userTemplate: 'u' },
      { kind: 'k', target: 't' },
      { agentId: 'a', decisionClass: 'c' },
    );
    expect(r.vote).toBe('abstain');
    expect(r.summary).toMatch(/not valid JSON/);
  });
});
