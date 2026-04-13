import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentManifest, Proposal, CalibrationScore, JournalEntry } from './types.js';
import type { PeerTransport } from './deliberation.js';

/**
 * MCP-based peer transport. Calls peer agents via MCP tool invocations
 * over Streamable HTTP transport.
 *
 * Falls back to HTTP for manifest discovery (.well-known) since that's
 * a standard HTTP endpoint, not an MCP tool.
 */
export class McpTransport implements PeerTransport {

  async fetchManifest(peerUrl: string): Promise<AgentManifest> {
    // Manifest is always served via plain HTTP (.well-known)
    const res = await fetch(`${peerUrl}/.well-known/adp-manifest.json`);
    if (!res.ok) throw new Error(`Manifest fetch failed: ${peerUrl} → ${res.status}`);
    return res.json() as Promise<AgentManifest>;
  }

  async fetchCalibration(journalEndpoint: string, agentId: string, domain: string): Promise<CalibrationScore> {
    const mcpUrl = this.toMcpUrl(journalEndpoint);
    try {
      const result = await this.callTool(mcpUrl, 'adj_calibration', { agentId, domain });
      return JSON.parse(result);
    } catch {
      return { value: 0.5, sampleSize: 0, staleness: 0 };
    }
  }

  async requestProposal(peerUrl: string, deliberationId: string, action: any, tier: string): Promise<Proposal> {
    const result = await this.callTool(`${peerUrl}/mcp`, 'adp_propose', {
      deliberationId,
      actionKind: action.kind,
      actionTarget: action.target,
      actionParameters: action.parameters,
      reversibilityTier: tier,
    });
    return JSON.parse(result);
  }

  async sendFalsification(peerUrl: string, conditionId: string, round: number, evidenceAgentId: string) {
    const result = await this.callTool(`${peerUrl}/mcp`, 'adp_falsify', {
      conditionId, round, evidenceAgentId,
    });
    return JSON.parse(result);
  }

  async pushJournalEntries(peerUrl: string, entries: JournalEntry[]): Promise<void> {
    await this.callTool(`${peerUrl}/mcp`, 'adj_append_entries', {
      entries: JSON.stringify(entries),
    });
  }

  private toMcpUrl(journalEndpoint: string): string {
    // journalEndpoint is like http://host:port/adj/v0 → MCP endpoint is http://host:port/mcp
    return journalEndpoint.replace(/\/adj\/v0$/, '/mcp');
  }

  private async callTool(mcpUrl: string, toolName: string, args: Record<string, any>): Promise<string> {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    const client = new Client({ name: 'adp-peer-client', version: '0.1.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({ name: toolName, arguments: args });

      const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
      const textContent = content?.find(c => c.type === 'text');
      if (!textContent || textContent.type !== 'text' || typeof textContent.text !== 'string') {
        throw new Error(`Tool ${toolName} returned no text content`);
      }
      return textContent.text;
    } finally {
      await client.close();
    }
  }
}
