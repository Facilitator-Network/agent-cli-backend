import { Router } from 'express';
import { ethers } from 'ethers';
import redis from '../lib/redis.js';
import {
  CCTP,
  CCTP_DOMAINS,
  USDC_ADDRESSES,
  TREASURY_ADDRESS,
  RELAYER_PRIVATE_KEY,
  CONTRACTS,
} from '../lib/constants.js';
import {
  TOKEN_MESSENGER_ABI,
  MESSAGE_TRANSMITTER_ABI,
  ERC20_APPROVE_ABI,
} from '../lib/abi.js';

const router = Router();
const BRIDGE_TTL_SEC = 24 * 60 * 60; // 24 hours
const ATTESTATION_POLL_MS = 5000;
const ATTESTATION_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

function getProvider(rpc) {
  return new ethers.JsonRpcProvider(rpc);
}

function getSigner(privateKey, provider) {
  return new ethers.Wallet(privateKey, provider);
}

/**
 * Poll Circle attestation API until we get a signed attestation or timeout.
 * @param {string} messageHash - keccak256(messageBytes) as 0x-prefixed hex
 * @returns {Promise<string|null>} attestation signature bytes (hex) or null on timeout
 */
async function pollAttestation(messageHash) {
  const hashForUrl = typeof messageHash === 'string' && messageHash.startsWith('0x')
    ? messageHash.slice(2)
    : messageHash;
  const url = `${CCTP.attestationApi}/${hashForUrl}`;
  const deadline = Date.now() + ATTESTATION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.status === 'complete' && data.attestation) {
        return data.attestation;
      }
    } catch (_) {
      // ignore fetch errors, keep polling
    }
    await new Promise((r) => setTimeout(r, ATTESTATION_POLL_MS));
  }
  return null;
}

/**
 * Fire-and-forget: execute CCTP bridge (approve → depositForBurn → attest → receiveMessage).
 * Updates Redis at each step.
 */
async function executeBridge(bridgeId) {
  if (!redis) {
    console.error('[bridge] Redis not configured, cannot execute bridge', bridgeId);
    return;
  }
  if (!RELAYER_PRIVATE_KEY) {
    // bridgeId already includes 'bridge:' prefix, use as-is
    try {
      await redis.hset(bridgeId, { status: 'failed', error: 'Relayer not configured' });
    } catch (_) {}
    return;
  }

  // Small delay to ensure Redis write completes (race condition protection)
  await new Promise((r) => setTimeout(r, 100));

  let data;
  try {
    // bridgeId already includes 'bridge:' prefix from initiate endpoint
    data = await redis.hgetall(bridgeId);
  } catch (e) {
    console.error('[bridge] Failed to read bridge state', bridgeId, e.message);
    return;
  }

  // Check if data exists and has content
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    console.error('[bridge] Bridge record not found or empty', bridgeId);
    return;
  }

  const {
    sourceChain,
    amount,
    finalRecipient,
    purpose,
  } = data;
  
  if (!sourceChain || amount == null || !finalRecipient) {
    try {
      await redis.hset(bridgeId, { status: 'failed', error: 'Missing bridge params' });
    } catch (_) {}
    return;
  }

  const sourceConfig = CONTRACTS[sourceChain];
  const fujiConfig = CONTRACTS.fuji;
  const sourceUsdc = USDC_ADDRESSES[sourceChain];
  const fujiDomain = CCTP.fujiDomain;

  if (!sourceConfig || !sourceUsdc) {
    try {
      await redis.hset(bridgeId, { status: 'failed', error: `Unsupported source chain: ${sourceChain}` });
    } catch (_) {}
    return;
  }

  const amountWei = ethers.parseUnits(amount.toString(), 6);
  const mintRecipient = ethers.zeroPadValue(finalRecipient, 32);

  const sourceProvider = getProvider(sourceConfig.rpc);
  const relayer = getSigner(RELAYER_PRIVATE_KEY, sourceProvider);

  try {
    // 1. Approve
    await redis.hset(bridgeId, { status: 'approved' });
    const usdc = new ethers.Contract(sourceUsdc, ERC20_APPROVE_ABI, relayer);
    const approveTx = await usdc.approve(CCTP.tokenMessenger, amountWei);
    await approveTx.wait();

    // 2. Burn (depositForBurn)
    await redis.hset(bridgeId, { status: 'deposited' });
    const tokenMessenger = new ethers.Contract(CCTP.tokenMessenger, TOKEN_MESSENGER_ABI, relayer);
    const burnTx = await tokenMessenger.depositForBurn(
      amountWei,
      fujiDomain,
      mintRecipient,
      sourceUsdc
    );
    const burnReceipt = await burnTx.wait();
    await redis.hset(bridgeId, {
      status: 'message_sent',
      depositForBurnTx: burnReceipt.hash,
    });

    // 3. Extract MessageSent(bytes) from receipt (from MessageTransmitter contract)
    const mtInterface = new ethers.Interface(MESSAGE_TRANSMITTER_ABI);
    const transmitterAddress = CCTP.messageTransmitter.toLowerCase();
    let messageBytes = null;
    for (const log of burnReceipt.logs) {
      if (log.address && log.address.toLowerCase() !== transmitterAddress) continue;
      try {
        const parsed = mtInterface.parseLog({ topics: log.topics, data: log.data });
        if (parsed && parsed.name === 'MessageSent') {
          messageBytes = parsed.args.message;
          break;
        }
      } catch (_) {}
    }
    if (!messageBytes) {
      await redis.hset(bridgeId, {
        status: 'failed',
        error: 'Could not find MessageSent event in burn receipt',
      });
      return;
    }

    const messageHash = ethers.keccak256(messageBytes);
    await redis.hset(bridgeId, { messageBytes, messageHash, status: 'polling_attestation' });

    // 4. Poll attestation
    const attestation = await pollAttestation(messageHash);
    if (!attestation) {
      await redis.hset(bridgeId, {
        status: 'failed',
        error: 'Attestation timeout (15 min). You can retry receiveMessage later with same messageHash.',
      });
      return;
    }

    await redis.hset(bridgeId, { attestation, status: 'attestation_received' });

    // 5. Mint on Fuji (receiveMessage)
    const fujiProvider = getProvider(fujiConfig.rpc);
    const fujiRelayer = getSigner(RELAYER_PRIVATE_KEY, fujiProvider);
    const transmitter = new ethers.Contract(
      CCTP.messageTransmitter,
      MESSAGE_TRANSMITTER_ABI,
      fujiRelayer
    );
    const attestationBytes = typeof attestation === 'string' && attestation.startsWith('0x')
      ? attestation
      : ethers.getBytes(attestation);
    const receiveTx = await transmitter.receiveMessage(messageBytes, attestationBytes);
    const receiveReceipt = await receiveTx.wait();

    await redis.hset(bridgeId, {
      status: 'completed',
      receiveMessageTx: receiveReceipt.hash,
      completedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[bridge] executeBridge error', bridgeId, e.message);
    try {
      await redis.hset(bridgeId, {
        status: 'failed',
        error: e.message || String(e),
      });
    } catch (redisErr) {
      console.error('[bridge] Failed to update Redis on error', bridgeId, redisErr.message);
    }
  }
}

// POST /api/bridge/initiate — CLI calls after payment confirmed on source chain
router.post('/initiate', async (req, res) => {
  if (!redis) {
    return res.status(503).json({ error: 'Bridge not configured (Upstash Redis required)' });
  }

  const { sourceChain, paymentTxHash, amount, finalRecipient, purpose } = req.body;
  if (!sourceChain || !paymentTxHash || amount == null || !finalRecipient || !purpose) {
    return res.status(400).json({
      error: 'sourceChain, paymentTxHash, amount, finalRecipient, purpose required',
    });
  }

  const netConfig = CONTRACTS[sourceChain];
  if (!netConfig) {
    return res.status(400).json({ error: `Unknown source chain: ${sourceChain}` });
  }
  if (!ethers.isAddress(finalRecipient)) {
    return res.status(400).json({ error: 'finalRecipient must be a valid address' });
  }

  const txPrefix = (paymentTxHash || '').replace(/^0x/, '').slice(0, 16);
  const bridgeId = `bridge:${Date.now()}:${txPrefix}`;

  const state = {
    sourceChain,
    paymentTxHash,
    amount: amount.toString(),
    finalRecipient,
    purpose,
    status: 'initiated',
    createdAt: new Date().toISOString(),
  };

  try {
    await redis.hset(bridgeId, state);
    await redis.expire(bridgeId, BRIDGE_TTL_SEC);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Fire-and-forget (do not await)
  executeBridge(bridgeId).catch((err) => console.error('[bridge] executeBridge unhandled', err));

  return res.json({
    bridgeId,
    status: 'initiated',
  });
});

// GET /api/bridge/status/:bridgeId
router.get('/status/:bridgeId', async (req, res) => {
  if (!redis) {
    return res.status(503).json({ error: 'Bridge not configured' });
  }

  const { bridgeId } = req.params;
  if (!bridgeId || !bridgeId.startsWith('bridge:')) {
    return res.status(400).json({ error: 'Invalid bridgeId' });
  }

  try {
    const data = await redis.hgetall(bridgeId);
    if (!data || Object.keys(data).length === 0) {
      return res.status(404).json({ error: 'Bridge not found' });
    }
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
