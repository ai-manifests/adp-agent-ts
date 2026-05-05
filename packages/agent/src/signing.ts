import * as ed from '@noble/ed25519';
import { createHash } from 'node:crypto';
import type { Proposal } from './types.js';

// noble/ed25519 v2 requires a sha512 hash function
ed.etc.sha512Sync = (...m: Uint8Array[]) => {
  const h = createHash('sha512');
  for (const msg of m) h.update(msg);
  return new Uint8Array(h.digest());
};

/**
 * Generate an Ed25519 key pair. Returns hex-encoded keys.
 */
export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return {
    publicKey: Buffer.from(publicKey).toString('hex'),
    privateKey: Buffer.from(privateKey).toString('hex'),
  };
}

/**
 * Deterministic JSON canonicalization: recursively sorted object keys, no
 * whitespace, arrays in insertion order, primitives via standard JSON.
 * Excludes the 'signature' field from the canonical form at the top level.
 *
 * This is a simplified RFC 8785 (JCS) variant — sufficient for ADP data
 * shapes, which only contain strings, numbers, booleans, nulls, arrays,
 * and objects with string keys. The algorithm must produce bit-identical
 * output in every language-specific reference implementation so that
 * signatures produced in one language verify in any other.
 *
 * NOTE: This algorithm replaces an earlier implementation that passed
 * `Object.keys(copy).sort()` as the replacer argument to `JSON.stringify`,
 * which silently dropped all nested object keys whose names did not
 * happen to match a top-level proposal key — an integrity hole and a
 * cross-language incompatibility. Signatures produced by v0.2.x and
 * earlier will NOT verify against v0.3.0 and later; this is intentional.
 */
export function canonicalize(proposal: Proposal): string {
  const { signature, ...rest } = proposal as any;
  void signature;
  return canonicalizeValue(rest);
}

/**
 * Recursive canonical JSON serializer. Exported for golden-vector tests
 * and cross-language parity verification; most callers should use
 * `canonicalize(proposal)` directly.
 */
export function canonicalizeValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeValue).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalizeValue(obj[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`Cannot canonicalize value of type ${typeof value}`);
}

/**
 * Sign a proposal with an Ed25519 private key.
 * Returns the hex-encoded signature.
 */
export async function signProposal(proposal: Proposal, privateKeyHex: string): Promise<string> {
  const message = new TextEncoder().encode(canonicalize(proposal));
  const privateKey = Buffer.from(privateKeyHex, 'hex');
  const signature = await ed.signAsync(message, privateKey);
  return Buffer.from(signature).toString('hex');
}

/**
 * Verify a proposal's signature against a public key.
 */
export async function verifyProposal(
  proposal: Proposal,
  signatureHex: string,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const message = new TextEncoder().encode(canonicalize(proposal));
    const signature = Buffer.from(signatureHex, 'hex');
    const publicKey = Buffer.from(publicKeyHex, 'hex');
    return await ed.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}
