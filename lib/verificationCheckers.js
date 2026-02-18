import { ethers } from 'ethers';
import { CONTRACTS } from './constants.js';

/**
 * ERC-8126 Verification Checkers
 *
 * Three verification dimensions:
 * - WAV (Web Availability Verification): Is the agent's URL accessible, SSL-secured, responsive?
 * - WV (Wallet Verification): Is the owner wallet active with transaction history?
 * - ETV (Existing Transaction Verification): Does the on-chain registration exist and is the contract active?
 *
 * Each returns a score 0-100. Higher = safer.
 */

// ---- WAV: Web Availability Verification ----
export async function checkWebAvailability(agentUrl) {
  if (!agentUrl) return { score: 0, details: { error: 'No URL provided' } };

  const details = {};
  let score = 0;

  try {
    // Check URL format
    const url = new URL(agentUrl);
    details.protocol = url.protocol;

    // SSL check (https = +20 points)
    if (url.protocol === 'https:') {
      score += 20;
      details.ssl = true;
    } else {
      details.ssl = false;
    }

    // HTTP GET with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const start = Date.now();
    const res = await fetch(agentUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'ERC8126-Verifier/1.0' },
    });
    clearTimeout(timeout);

    const latency = Date.now() - start;
    details.statusCode = res.status;
    details.latencyMs = latency;

    // Status code check (+25 points for 2xx)
    if (res.status >= 200 && res.status < 300) {
      score += 25;
      details.accessible = true;
    } else if (res.status >= 300 && res.status < 400) {
      score += 15; // Redirect is okay but not ideal
      details.accessible = 'redirect';
    } else {
      details.accessible = false;
    }

    // Latency scoring (+20 for <1s, +15 for <3s, +10 for <5s, +5 for <10s)
    if (latency < 1000) score += 20;
    else if (latency < 3000) score += 15;
    else if (latency < 5000) score += 10;
    else score += 5;

    // Content-type check (+15 for JSON API)
    const contentType = res.headers.get('content-type') || '';
    details.contentType = contentType;
    if (contentType.includes('json')) {
      score += 15;
      details.jsonApi = true;
    } else if (contentType.includes('html')) {
      score += 10;
      details.jsonApi = false;
    } else {
      score += 5;
    }

    // CORS headers check (+10)
    const corsHeader = res.headers.get('access-control-allow-origin');
    if (corsHeader) {
      score += 10;
      details.cors = true;
    } else {
      details.cors = false;
    }

    // Security headers (+10)
    let secHeaders = 0;
    if (res.headers.get('x-content-type-options')) secHeaders++;
    if (res.headers.get('x-frame-options')) secHeaders++;
    if (res.headers.get('strict-transport-security')) secHeaders++;
    if (res.headers.get('content-security-policy')) secHeaders++;
    details.securityHeaders = secHeaders;
    score += Math.min(secHeaders * 3, 10);

  } catch (e) {
    details.error = e.message;
    details.accessible = false;
    // Unreachable URL gets minimal score
    score = 5;
  }

  return { score: Math.min(score, 100), details };
}

// ---- WV: Wallet Verification ----
export async function checkWalletVerification(ownerAddress, networkKey) {
  if (!ownerAddress) return { score: 0, details: { error: 'No address provided' } };

  const network = CONTRACTS[networkKey] || CONTRACTS.fuji;
  const details = {};
  let score = 0;

  try {
    const provider = new ethers.JsonRpcProvider(network.rpc);

    // Transaction count (+30 for any, +40 for 10+, +50 for 100+)
    const txCount = await provider.getTransactionCount(ownerAddress);
    details.transactionCount = txCount;

    if (txCount >= 100) score += 50;
    else if (txCount >= 10) score += 40;
    else if (txCount >= 1) score += 30;

    // Balance check (+20 for any balance, +10 bonus for >0.01 ETH)
    const balance = await provider.getBalance(ownerAddress);
    const balanceEth = parseFloat(ethers.formatEther(balance));
    details.balance = balanceEth;

    if (balanceEth > 0.01) score += 30;
    else if (balanceEth > 0) score += 20;

    // Code check — if address is a contract, that's interesting info but not scored higher
    const code = await provider.getCode(ownerAddress);
    details.isContract = code !== '0x';

    // Nonce > 0 already covered by txCount

    // Activity scoring: if txCount > 0 and balance > 0, +20 (active wallet)
    if (txCount > 0 && balanceEth > 0) {
      score += 20;
      details.active = true;
    } else {
      details.active = false;
    }

  } catch (e) {
    details.error = e.message;
    score = 5;
  }

  return { score: Math.min(score, 100), details };
}

// ---- ETV: Existing Transaction Verification ----
export async function checkOnChainTransaction(agentId, networkKey) {
  if (!agentId) return { score: 0, details: { error: 'No agentId provided' } };

  const network = CONTRACTS[networkKey];
  if (!network) return { score: 0, details: { error: `Unknown network: ${networkKey}` } };

  const details = {};
  let score = 0;

  try {
    const provider = new ethers.JsonRpcProvider(network.rpc);
    const registryAddress = network.identityRegistry;

    // Check if registry contract exists (+20)
    const code = await provider.getCode(registryAddress);
    details.registryExists = code !== '0x';
    if (code !== '0x') score += 20;

    // Try to read the agent's owner from the identity registry (ERC-721 ownerOf)
    const iface = new ethers.Interface([
      'function ownerOf(uint256 tokenId) view returns (address)',
      'function agentURI(uint256 agentId) view returns (string)',
    ]);

    const contract = new ethers.Contract(registryAddress, iface, provider);

    // Check ownership (+30)
    try {
      const owner = await contract.ownerOf(agentId);
      details.owner = owner;
      details.registered = true;
      score += 30;
    } catch {
      details.registered = false;
    }

    // Check agent URI (+20)
    try {
      const uri = await contract.agentURI(agentId);
      details.agentURI = uri;
      if (uri && uri.length > 0) score += 20;
    } catch {
      details.agentURI = null;
    }

    // Check if registered on multiple networks (+30)
    let multiNetworkCount = 0;
    for (const [key, net] of Object.entries(CONTRACTS)) {
      if (key === networkKey) continue;
      try {
        const p = new ethers.JsonRpcProvider(net.rpc);
        const c = new ethers.Contract(net.identityRegistry, iface, p);
        await c.ownerOf(agentId);
        multiNetworkCount++;
      } catch {
        // Not registered on this network
      }
    }
    details.multiNetworkCount = multiNetworkCount + (details.registered ? 1 : 0);
    score += Math.min(multiNetworkCount * 15, 30);

  } catch (e) {
    details.error = e.message;
    score = 5;
  }

  return { score: Math.min(score, 100), details };
}

// ---- Composite Score ----
/**
 * Compute weighted composite score and risk tier.
 * WAV 35% + WV 35% + ETV 30%
 */
export function computeCompositeScore(wavScore, wvScore, etvScore) {
  const composite = Math.round(wavScore * 0.35 + wvScore * 0.35 + etvScore * 0.30);

  let riskTier;
  if (composite >= 80) riskTier = 'MINIMAL';
  else if (composite >= 60) riskTier = 'LOW';
  else if (composite >= 40) riskTier = 'MEDIUM';
  else if (composite >= 20) riskTier = 'HIGH';
  else riskTier = 'CRITICAL';

  return { overallScore: composite, riskTier };
}

/**
 * Map risk tier string to contract enum value.
 */
export function riskTierToEnum(tier) {
  const map = { UNVERIFIED: 0, CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4, MINIMAL: 5 };
  return map[tier] ?? 0;
}
