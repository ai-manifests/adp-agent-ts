import { exec } from 'child_process';
import { promisify } from 'util';
import type { EvaluatorConfig, EvaluationResult, Vote } from './types.js';

const execAsync = promisify(exec);

/**
 * Run an evaluator plugin and return an EvaluationResult.
 * - 'static' returns null (caller uses defaults)
 * - 'shell' runs a command via shell and parses the output
 */
export async function evaluate(
  config: EvaluatorConfig | undefined,
  action: { kind: string; target: string; parameters?: Record<string, string> },
): Promise<EvaluationResult | null> {
  if (!config || config.kind === 'static') return null;

  if (config.kind === 'shell') {
    return evaluateShell(config, action);
  }

  return null;
}

async function evaluateShell(
  config: EvaluatorConfig,
  action: { kind: string; target: string; parameters?: Record<string, string> },
): Promise<EvaluationResult> {
  const command = config.command;
  if (!command) {
    return fallback('No command configured', 'abstain');
  }

  const timeoutMs = config.timeoutMs ?? 120_000;
  const parseMode = config.parseOutput ?? 'exit-code';

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: config.workDir,
      timeout: timeoutMs,
      env: {
        ...process.env,
        ADP_ACTION_KIND: action.kind,
        ADP_ACTION_TARGET: action.target,
        ADP_ACTION_PARAMS: JSON.stringify(action.parameters ?? {}),
      },
    });

    if (parseMode === 'json') {
      return parseJsonOutput(stdout);
    }

    // exit-code mode: exit 0 = approve
    return {
      vote: 'approve',
      confidence: 0.85,
      summary: stderr.trim() || stdout.trim() || 'Command succeeded',
      evidenceRefs: [],
      dissentConditions: [],
    };
  } catch (err: any) {
    // exec throws on non-zero exit OR timeout OR missing command
    if (err.killed) {
      return fallback(`Command timed out after ${timeoutMs}ms`, 'abstain');
    }

    // Non-zero exit code (err.code is the exit code number)
    if (typeof err.code === 'number') {
      if (parseMode === 'json' && err.stdout) {
        try {
          return parseJsonOutput(err.stdout);
        } catch { /* fall through to reject */ }
      }

      return {
        vote: 'reject',
        confidence: 0.75,
        summary: err.stderr?.trim() || err.message || 'Command failed',
        evidenceRefs: [],
        dissentConditions: [],
      };
    }

    // Command not found or other system error (err.code is a string like 'ENOENT')
    return fallback(`Evaluator error: ${err.message}`, 'abstain');
  }
}

function parseJsonOutput(stdout: string): EvaluationResult {
  const parsed = JSON.parse(stdout.trim());
  return {
    vote: parsed.vote ?? 'abstain',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    summary: parsed.summary ?? '',
    evidenceRefs: Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs : [],
    dissentConditions: Array.isArray(parsed.dissentConditions) ? parsed.dissentConditions : [],
  };
}

function fallback(summary: string, vote: Vote): EvaluationResult {
  return { vote, confidence: 0.5, summary, evidenceRefs: [], dissentConditions: [] };
}
