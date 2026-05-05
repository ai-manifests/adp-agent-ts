import type { Request, Response, NextFunction } from 'express';
import type { AuthConfig } from '../types.js';

/**
 * Express middleware that validates bearer tokens on protected endpoints.
 *
 * If auth is not configured (no bearerToken in config), all requests are allowed
 * for backward compatibility with tests.
 *
 * Public endpoints (/.well-known/*, /healthz, GET /adj/v0/*) should NOT use this middleware.
 */
export function createAuthMiddleware(auth: AuthConfig | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // No auth configured — allow all (test/dev mode)
    if (!auth?.bearerToken) {
      next();
      return;
    }

    // Extract bearer token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required. Provide Authorization: Bearer <token>' });
      return;
    }

    const token = authHeader.slice(7);
    if (token !== auth.bearerToken) {
      res.status(403).json({ error: 'Invalid bearer token' });
      return;
    }

    next();
  };
}

/**
 * Returns the bearer token to use when calling a specific peer.
 * Falls back to a default token if the peer isn't in the peerTokens map.
 */
export function getPeerToken(auth: AuthConfig | undefined, peerAgentId: string): string | null {
  if (!auth) return null;
  return auth.peerTokens?.[peerAgentId] ?? auth.peerTokens?.['*'] ?? null;
}

/**
 * Builds Authorization headers for outgoing peer requests.
 */
export function authHeaders(auth: AuthConfig | undefined, peerAgentId: string): Record<string, string> {
  const token = getPeerToken(auth, peerAgentId);
  if (!token) return {};
  return { 'Authorization': `Bearer ${token}` };
}
