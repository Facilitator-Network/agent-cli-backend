import { createVerifierClient, parseKeyId } from '@slicekit/erc8128';
import { ethers } from 'ethers';
import nonceStore from '../lib/nonceStore.js';

/**
 * Verify an ERC-191 personal_sign message.
 * Accepts: { address, message: { raw: Hex }, signature: Hex }
 * Returns true if the recovered address matches.
 */
async function verifyMessage({ address, message, signature }) {
  try {
    const messageBytes = ethers.getBytes(message.raw);
    const recovered = ethers.verifyMessage(messageBytes, signature);
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

// Create the ERC-8128 verifier client
const verifier = createVerifierClient(verifyMessage, nonceStore, {
  replayable: false,
  clockSkewSec: 60,
  maxValiditySec: 300,
});

/**
 * Convert an Express request to a Web API Request for ERC-8128 verification.
 */
function expressToRequest(req) {
  const protocol = req.protocol || 'https';
  const host = req.get('host') || 'localhost';
  const url = `${protocol}://${host}${req.originalUrl}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    }
  }

  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && req.body;

  return new Request(url, {
    method,
    headers,
    body: hasBody ? JSON.stringify(req.body) : undefined,
  });
}

/**
 * Optional ERC-8128 middleware.
 * If ERC-8128 headers (Signature-Input, Signature) are present, verifies them
 * and attaches req.verifiedAddress and req.verifiedChainId.
 * If headers are absent, passes through (backwards compatible).
 */
export async function erc8128Optional(req, res, next) {
  const sigInput = req.headers['signature-input'];
  const sig = req.headers['signature'];

  // No ERC-8128 headers — pass through
  if (!sigInput || !sig) {
    return next();
  }

  try {
    const webRequest = expressToRequest(req);
    const result = await verifier.verifyRequest(webRequest);

    if (result.ok) {
      req.verifiedAddress = result.address;
      req.verifiedChainId = result.chainId;
    } else {
      // ERC-8128 headers present but invalid — log but don't block (optional mode)
      console.warn(`ERC-8128 verification failed: ${result.reason} — ${result.detail || ''}`);
    }
  } catch (e) {
    console.warn('ERC-8128 middleware error:', e.message);
  }

  next();
}

/**
 * Required ERC-8128 middleware.
 * Returns 401 if ERC-8128 headers are missing or invalid.
 */
export async function erc8128Required(req, res, next) {
  const sigInput = req.headers['signature-input'];
  const sig = req.headers['signature'];

  if (!sigInput || !sig) {
    return res.status(401).json({ error: 'ERC-8128 signed request required' });
  }

  try {
    const webRequest = expressToRequest(req);
    const result = await verifier.verifyRequest(webRequest);

    if (!result.ok) {
      return res.status(401).json({
        error: 'ERC-8128 verification failed',
        reason: result.reason,
        detail: result.detail,
      });
    }

    req.verifiedAddress = result.address;
    req.verifiedChainId = result.chainId;
    next();
  } catch (e) {
    console.warn('ERC-8128 required middleware error:', e.message);
    return res.status(401).json({ error: 'ERC-8128 verification error' });
  }
}
