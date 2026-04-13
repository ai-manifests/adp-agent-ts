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
 * Deterministic JSON canonicalization: sorted keys, no whitespace.
 * Excludes the 'signature' field from the canonical form.
 */
export function canonicalize(proposal: Proposal): string {
  const { ...copy } = proposal as any;
  delete copy.signature;
  return JSON.stringify(copy, Object.keys(copy).sort());
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
