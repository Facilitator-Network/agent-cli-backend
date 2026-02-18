import { Router } from 'express';
import { ethers } from 'ethers';
import redis from '../lib/redis.js';
import { CONTRACTS, RELAYER_PRIVATE_KEY } from '../lib/constants.js';
import {
  checkWebAvailability,
  checkWalletVerification,
  checkOnChainTransaction,
  computeCompositeScore,
  riskTierToEnum,
} from '../lib/verificationCheckers.js';

const ERC8126_ABI = [
  'function submitVerification(uint256 agentId, uint8 overallRiskScore, uint8 riskTier, tuple(uint8 proofType, uint8 score, string details)[] proofs)',
  'function getAgentVerification(uint256 agentId) view returns (bool isVerified, uint8 overallScore, uint8 riskTier, uint256 verifiedAt, uint256 proofCount)',
  'function getAgentProofs(uint256 agentId) view returns (tuple(uint8 proofType, uint8 score, string details, uint256 timestamp)[])',
];

const router = Router();

// Cache TTL: 1 hour
const CACHE_TTL = 3600;

// ---- POST /verify/:network/:agentId → Trigger verification ----
router.post('/:network/:agentId', async (req, res) => {
  const { network, agentId } = req.params;

  if (!CONTRACTS[network]) {
    return res.status(400).json({ error: `Unknown network: ${network}` });
  }

  try {
    // Look up agent in Upstash
    let agent = null;
    if (redis) {
      agent = await redis.hgetall(`agent:${network}:${agentId}`);
    }

    const agentUrl = agent?.url || agent?.mcpEndpoint || agent?.a2aEndpoint || '';
    const ownerAddress = agent?.ownerAddress || '';

    // Run all 3 checkers in parallel
    const [wavResult, wvResult, etvResult] = await Promise.all([
      checkWebAvailability(agentUrl),
      checkWalletVerification(ownerAddress, network),
      checkOnChainTransaction(agentId, network),
    ]);

    // Compute composite score
    const { overallScore, riskTier } = computeCompositeScore(
      wavResult.score,
      wvResult.score,
      etvResult.score,
    );

    const verificationResult = {
      agentId,
      network,
      overallScore,
      riskTier,
      proofs: [
        {
          proofType: 'WAV',
          score: wavResult.score,
          details: wavResult.details,
          timestamp: new Date().toISOString(),
        },
        {
          proofType: 'WV',
          score: wvResult.score,
          details: wvResult.details,
          timestamp: new Date().toISOString(),
        },
        {
          proofType: 'ETV',
          score: etvResult.score,
          details: etvResult.details,
          timestamp: new Date().toISOString(),
        },
      ],
      verifiedAt: new Date().toISOString(),
    };

    // Submit verification on-chain via relayer
    let onChainTx = null;
    const net = CONTRACTS[network];
    if (RELAYER_PRIVATE_KEY && net.verificationRegistry) {
      try {
        const provider = new ethers.JsonRpcProvider(net.rpc);
        const wallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
        const contract = new ethers.Contract(net.verificationRegistry, ERC8126_ABI, wallet);

        const proofs = [
          { proofType: 0, score: wavResult.score, details: JSON.stringify(wavResult.details) },
          { proofType: 1, score: wvResult.score, details: JSON.stringify(wvResult.details) },
          { proofType: 2, score: etvResult.score, details: JSON.stringify(etvResult.details) },
        ];

        const tx = await contract.submitVerification(
          agentId,
          overallScore,
          riskTierToEnum(riskTier),
          proofs,
        );
        await tx.wait();
        onChainTx = tx.hash;
        console.log(`  Verification submitted on-chain: ${tx.hash}`);
      } catch (e) {
        console.error(`  On-chain submission failed (${network}):`, e.message);
      }
    }

    verificationResult.onChainTx = onChainTx;

    // Cache in Redis
    if (redis) {
      await redis.set(
        `verify:${network}:${agentId}`,
        JSON.stringify(verificationResult),
        { ex: CACHE_TTL },
      );
    }

    return res.json(verificationResult);
  } catch (e) {
    console.error('Verification error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- GET /verify/:network/:agentId → Get cached verification ----
router.get('/:network/:agentId', async (req, res) => {
  const { network, agentId } = req.params;

  if (!redis) {
    return res.status(503).json({ error: 'Redis not configured' });
  }

  try {
    const cached = await redis.get(`verify:${network}:${agentId}`);
    if (!cached) {
      return res.json(null);
    }

    const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
    return res.json(data);
  } catch (e) {
    console.error('Get verification error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- GET /verify/:network/:agentId/on-chain → Read from contract via RPC ----
router.get('/:network/:agentId/on-chain', async (req, res) => {
  const { network, agentId } = req.params;

  const net = CONTRACTS[network];
  if (!net) {
    return res.status(400).json({ error: `Unknown network: ${network}` });
  }

  try {
    if (!net.verificationRegistry) {
      return res.status(400).json({ error: 'Verification contract not deployed on this network' });
    }

    const provider = new ethers.JsonRpcProvider(net.rpc);
    const contract = new ethers.Contract(net.verificationRegistry, ERC8126_ABI, provider);

    const [isVerified, overallScore, riskTier, verifiedAt, proofCount] =
      await contract.getAgentVerification(agentId);

    if (!isVerified) {
      return res.json({ message: 'No on-chain verification record', source: 'on-chain' });
    }

    const TIER_NAMES = ['UNVERIFIED', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'MINIMAL'];

    const result = {
      agentId,
      network,
      isVerified,
      overallScore: Number(overallScore),
      riskTier: TIER_NAMES[Number(riskTier)] || 'UNVERIFIED',
      verifiedAt: new Date(Number(verifiedAt) * 1000).toISOString(),
      proofCount: Number(proofCount),
      source: 'on-chain',
    };

    return res.json(result);
  } catch (e) {
    console.error('On-chain verification read error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

export default router;
