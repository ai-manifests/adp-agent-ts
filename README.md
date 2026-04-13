# ADP Agent Monorepo

Reference implementation of the Agent Deliberation Protocol. Monorepo for adp-agent and adp-agent-anchor.

## Table of Contents

- [Overview](#overview)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
  - [Using adp-agent](#using-adp-agent)
  - [Using adp-agent-anchor](#using-adp-agent-anchor)
- [API Documentation](#api-documentation)
  - [Core Agent API](#core-agent-api)
  - [Anchor Integration](#anchor-integration)
- [Code Examples](#code-examples)
  - [Basic Agent Setup](#basic-agent-setup)
  - [Neo Blockchain Integration](#neo-blockchain-integration)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Overview

The ADP Agent Monorepo provides a reference implementation of the Agent Deliberation Protocol, designed to facilitate multi-agent communication and decision-making. This monorepo contains two main packages:

- **adp-agent**: Core agent implementation with Model Context Protocol (MCP) SDK integration
- **adp-agent-anchor**: Neo blockchain integration for agent anchoring and verification

The project leverages cryptographic signatures (Ed25519), Express.js for HTTP endpoints, and integrates with the Neo blockchain for decentralized agent identity management.

## Project Structure

```
adp-agent-monorepo/
├── packages/
│   ├── agent/              # Core agent implementation
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── agent-anchor/       # Neo blockchain integration
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
├── package.json            # Root package configuration
├── tsconfig.json           # TypeScript project references
└── tsconfig.base.json      # Shared TypeScript config
```

## Prerequisites

Before installing and using this project, ensure you have the following:

- **Node.js**: Version 20.x, 22.x, 23.x, 24.x, or 25.x (required by better-sqlite3)
- **npm**: Version 9.x or higher
- **TypeScript**: 5.5.0 or higher (included as dev dependency)
- **Operating System**: Linux, macOS, or Windows with build tools for native modules

## Installation

### 1. Clone the Repository

```bash
git clone https://git.marketally.com/ai-manifests/adp-agent.git
cd adp-agent-monorepo
```

### 2. Install Dependencies

This monorepo uses npm workspaces. Install all dependencies from the root:

```bash
npm install
```

This will install dependencies for all workspace packages (`packages/agent` and `packages/agent-anchor`).

### 3. Build the Project

Build all packages:

```bash
npm run build
```

This compiles TypeScript source files to JavaScript in the `dist/` directories.

### 4. Run Tests

Execute tests across all packages:

```bash
npm test
```

## Configuration

### Environment Variables

Create a `.env` file in the root directory or in individual package directories:

```env
# Express server configuration
PORT=3000
HOST=localhost

# Neo blockchain configuration (for agent-anchor)
NEO_NETWORK=testnet
NEO_RPC_URL=https://testnet1.neo.org:443

# Agent configuration
AGENT_ID=your-agent-id
AGENT_PRIVATE_KEY=your-ed25519-private-key-hex
```

### TypeScript Configuration

The project uses composite TypeScript projects with shared base configuration:

- `tsconfig.base.json`: Shared compiler options
- `tsconfig.json`: Root project references
- Individual package `tsconfig.json` files extend the base configuration

## Usage

### Using adp-agent

The core agent package provides MCP SDK integration and Express-based HTTP endpoints.

#### Starting an Agent Server

```typescript
import express from 'express';
import { createAgent } from 'adp-agent';

const app = express();
const agent = createAgent({
  agentId: 'agent-001',
  privateKey: 'your-ed25519-private-key-hex'
});

// Register agent routes
app.use('/agent', agent.router);

app.listen(3000, () => {
  console.log('Agent server running on port 3000');
});
```

#### Agent Deliberation

```typescript
import { Agent } from 'adp-agent';

const agent = new Agent({
  id: 'deliberator-1',
  privateKey: process.env.AGENT_PRIVATE_KEY
});

// Initiate deliberation
const result = await agent.deliberate({
  topic: 'resource-allocation',
  participants: ['agent-002', 'agent-003'],
  data: {
    resources: ['cpu', 'memory', 'storage'],
    constraints: { maxCost: 1000 }
  }
});

console.log('Deliberation result:', result);
```

### Using adp-agent-anchor

The anchor package integrates with the Neo blockchain for agent verification and anchoring.

#### Anchoring an Agent on Neo

```typescript
import { NeoAnchor } from 'adp-agent-anchor';

const anchor = new NeoAnchor({
  network: 'testnet',
  rpcUrl: 'https://testnet1.neo.org:443'
});

// Anchor agent identity on blockchain
const txHash = await anchor.registerAgent({
  agentId: 'agent-001',
  publicKey: 'agent-public-key-hex',
  metadata: {
    name: 'Deliberation Agent 1',
    capabilities: ['reasoning', 'negotiation']
  }
});

console.log('Agent anchored with transaction:', txHash);
```

#### Verifying Agent Identity

```typescript
import { NeoAnchor } from 'adp-agent-anchor';

const anchor = new NeoAnchor({
  network: 'testnet',
  rpcUrl: 'https://testnet1.neo.org:443'
});

// Verify agent on blockchain
const isValid = await anchor.verifyAgent({
  agentId: 'agent-001',
  signature: 'signature-hex',
  message: 'message-to-verify'
});

console.log('Agent verification:', isValid);
```

## API Documentation

### Core Agent API

#### `Agent` Class

The main agent implementation with deliberation capabilities.

**Constructor Options:**

```typescript
interface AgentOptions {
  id: string;              // Unique agent identifier
  privateKey: string;      // Ed25519 private key (hex)
  mcpConfig?: MCPConfig;   // Model Context Protocol configuration
}
```

**Methods:**

- `deliberate(options: DeliberationOptions): Promise<DeliberationResult>`
  - Initiates a deliberation session with other agents
  - Parameters:
    - `topic`: String identifier for deliberation topic
    - `participants`: Array of agent IDs
    - `data`: Deliberation context data
  - Returns: Promise resolving to deliberation outcome

- `sign(message: string): string`
  - Signs a message using the agent's private key
  - Returns: Hex-encoded signature

- `verify(message: string, signature: string, publicKey: string): boolean`
  - Verifies a signature against a message
  - Returns: Boolean indicating validity

### Anchor Integration

#### `NeoAnchor` Class

Provides Neo blockchain integration for agent identity management.

**Constructor Options:**

```typescript
interface NeoAnchorOptions {
  network: 'mainnet' | 'testnet';
  rpcUrl: string;
  privateKey?: string;  // For transaction signing
}
```

**Methods:**

- `registerAgent(options: RegisterOptions): Promise<string>`
  - Registers agent identity on Neo blockchain
  - Returns: Transaction hash

- `verifyAgent(options: VerifyOptions): Promise<boolean>`
  - Verifies agent signature against blockchain record
  - Returns: Boolean indicating verification status

- `getAgentInfo(agentId: string): Promise<AgentInfo>`
  - Retrieves agent metadata from blockchain
  - Returns: Agent information object

## Code Examples

### Basic Agent Setup

```typescript
import { Agent } from 'adp-agent';
import express from 'express';

// Initialize agent
const agent = new Agent({
  id: 'my-agent',
  privateKey: process.env.AGENT_PRIVATE_KEY
});

// Create Express server
const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', agentId: agent.id });
});

// Deliberation endpoint
app.post('/deliberate', async (req, res) => {
  try {
    const result = await agent.deliberate(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000);
```

### Neo Blockchain Integration

```typescript
import { Agent } from 'adp-agent';
import { NeoAnchor } from 'adp-agent-anchor';

// Initialize agent and anchor
const agent = new Agent({
  id: 'blockchain-agent',
  privateKey: process.env.AGENT_PRIVATE_KEY
});

const anchor = new NeoAnchor({
  network: 'testnet',
  rpcUrl: process.env.NEO_RPC_URL,
  privateKey: process.env.NEO_PRIVATE_KEY
});

// Register agent on blockchain
async function setupAgent() {
  const publicKey = agent.getPublicKey();
  
  const txHash = await anchor.registerAgent({
    agentId: agent.id,
    publicKey: publicKey,
    metadata: {
      version: '0.1.0',
      capabilities: ['deliberation', 'verification']
    }
  });
  
  console.log(`Agent registered: ${txHash}`);
}

// Verify agent message
async function verifyMessage(message: string, signature: string) {
  const isValid = await anchor.verifyAgent({
    agentId: agent.id,
    signature: signature,
    message: message
  });
  
  return isValid;
}

setupAgent();
```

### Database Integration (Optional)

```typescript
import Database from 'better-sqlite3';
import { Agent } from 'adp-agent';

// Initialize SQLite database
const db = new Database('agent-data.db');

// Create schema
db.exec(`
  CREATE TABLE IF NOT EXISTS deliberations (
    id TEXT PRIMARY KEY,
    topic TEXT,
    participants TEXT,
    result TEXT,
    timestamp INTEGER
  )
`);

// Store deliberation results
const storeDeliberation = db.prepare(`
  INSERT INTO deliberations (id, topic, participants, result, timestamp)
  VALUES (?, ?, ?, ?, ?)
`);

const agent = new Agent({
  id: 'persistent-agent',
  privateKey: process.env.AGENT_PRIVATE_KEY
});

// Wrap deliberation with persistence
async function deliberateAndStore(options) {
  const result = await agent.deliberate(options);
  
  storeDeliberation.run(
    result.id,
    options.topic,
    JSON.stringify(options.participants),
    JSON.stringify(result),
    Date.now()
  );
  
  return result;
}
```

## Troubleshooting

### Common Issues

**Build Errors with better-sqlite3**

If you encounter native module compilation errors:

```bash
# Rebuild native modules
npm rebuild better-sqlite3

# Or install with specific Python version
npm install --python=/usr/bin/python3
```

**TypeScript Compilation Errors**

Ensure you're using the correct Node.js version:

```bash
node --version  # Should be 20.x, 22.x, 23.x, 24.x, or 25.x
```

Clear build artifacts and rebuild:

```bash
npm run clean
npm run build
```

**Neo Network Connection Issues**

Verify RPC endpoint availability:

```bash
curl -X POST https://testnet1.neo.org:443 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"getversion","params":[],"id":1}'
```

**Module Resolution Errors**

The project uses `NodeNext` module resolution. Ensure imports use correct extensions:

```typescript
// Correct
import { Agent } from './agent.js';

// Incorrect
import { Agent } from './agent';
```

### Debug Mode

Enable debug logging:

```bash
DEBUG=adp:* npm start
```

## Contributing

We welcome contributions to the ADP Agent project! Here's how to get started:

### Development Setup

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `npm test`
5. Run linting: `npm run lint` (if configured)
6. Commit your changes: `git commit -m 'Add my feature'`
7. Push to the branch: `git push origin feature/my-feature`
8. Submit a pull request

### Code Style

- Follow TypeScript strict mode guidelines
- Use meaningful variable and function names
- Add JSDoc comments for public APIs
- Write unit tests for new features
- Ensure all tests pass before submitting PR

### Testing

Add tests for new features in the appropriate package:

```typescript
// packages/agent/src/__tests__/agent.test.ts
import { describe, it, expect } from 'vitest';
import { Agent } from '../agent.js';

describe('Agent', () => {
  it('should create agent with valid config', () => {
    const agent = new Agent({
      id: 'test-agent',
      privateKey: 'test-key'
    });
    
    expect(agent.id).toBe('test-agent');
  });
});
```

### Reporting Issues

When reporting issues, please include:

- Node.js version
- npm version
- Operating system
- Error messages and stack traces
- Steps to reproduce

## License

This project is licensed under **CC0-1.0** (Creative Commons Zero v1.0 Universal).

This means the code is dedicated to the public domain. You can copy, modify, distribute and perform the work, even for commercial purposes, all without asking permission.

For more information, see the [LICENSE](LICENSE) file or visit https://creativecommons.org/publicdomain/zero/1.0/

---

**Homepage**: https://adp-manifest.dev

**Repository**: https://git.marketally.com/ai-manifests/adp-agent