import { Router } from 'express';
import { ethers } from 'ethers';
import axios from 'axios';
import {
  CONTRACTS,
  RELAYER_ADDRESS,
  RELAYER_PRIVATE_KEY,
  TREASURY_ADDRESS,
  FACINET_NETWORK_MAP,
  FACINET_API_URL,
} from '../lib/constants.js';
import { USDC_ERC3009_ABI } from '../lib/abi.js';

const router = Router();

function getProvider(rpc) {
  return new ethers.JsonRpcProvider(rpc);
}
function getSigner(privateKey, provider) {
  return new ethers.Wallet(privateKey, provider);
}

/**
 * Fetch a random active facilitator for the given network from Facinet.
 * @param {string} networkKey - Network key (sepolia, baseSepolia, fuji)
 * @returns {Promise<{id: string, name?: string, facilitatorWallet?: string}>}
 */
async function getRandomFacilitator(networkKey) {
  const facinetNetwork = FACINET_NETWORK_MAP[networkKey];
  if (!facinetNetwork) {
    throw new Error(`Network "${networkKey}" not supported by Facinet`);
  }

  try {
    const response = await axios.get(`${FACINET_API_URL}/api/facilitator/list`, {
      timeout: 10000,
      headers: { 'User-Agent': '8004agent-backend/1.0.0' },
    });

    if (!response.data.success || !Array.isArray(response.data.facilitators)) {
      throw new Error('Invalid facilitator list response');
    }

    const netConfig = CONTRACTS[networkKey];
    const activeFacilitators = response.data.facilitators.filter((f) => {
      if (f.status !== 'active') return false;
      if (f.network && f.network !== facinetNetwork) return false;
      if (f.chainId !== undefined && f.chainId !== netConfig.chainId) return false;
      return true;
    });

    if (activeFacilitators.length === 0) {
      throw new Error(`No active facilitators found for ${netConfig.name}`);
    }

    // Pick random facilitator
    const facilitator = activeFacilitators[Math.floor(Math.random() * activeFacilitators.length)];
    return facilitator;
  } catch (e) {
    throw new Error(`Failed to fetch facilitators: ${e.message}`);
  }
}

/**
 * Submit payment via Facinet facilitator (replaces relayer for gasless payments).
 * Falls back to relayer if Facinet fails.
 */
router.post('/submit', async (req, res) => {
  const { paymentData, signature, networkKey } = req.body;
  if (!paymentData || !signature || !networkKey) {
    return res.status(400).json({ error: 'paymentData, signature, networkKey required' });
  }

  const netConfig = CONTRACTS[networkKey];
  if (!netConfig) {
    return res.status(400).json({ error: `Unknown network: ${networkKey}` });
  }

  // Try Facinet first (no relayer key needed)
  try {
    const facilitator = await getRandomFacilitator(networkKey);
    const facinetNetwork = FACINET_NETWORK_MAP[networkKey];

    // Convert paymentData to Facinet's paymentPayload format
    const paymentPayload = {
      signature,
      authorization: {
        from: paymentData.message.from,
        to: paymentData.message.to,
        value: paymentData.message.value.toString(),
        validAfter: paymentData.message.validAfter.toString(),
        validBefore: paymentData.message.validBefore.toString(),
        nonce: paymentData.message.nonce,
      },
      domain: {
        name: paymentData.domain.name,
        version: paymentData.domain.version,
        chainId: paymentData.domain.chainId,
        verifyingContract: paymentData.domain.verifyingContract,
      },
    };

    const payload = {
      facilitatorId: facilitator.id,
      paymentPayload,
      network: facinetNetwork,
      chainId: netConfig.chainId,
      usdcAddress: paymentData.usdcAddress,
      domainName: paymentData.domain.name,
      domainVersion: paymentData.domain.version,
    };

    const response = await axios.post(`${FACINET_API_URL}/api/x402/settle-custom`, payload, {
      timeout: 30000,
    });

    if (!response.data.success) {
      throw new Error(response.data.error || response.data.message || 'Payment failed');
    }

    return res.json({
      txHash: response.data.txHash,
      facilitator: facilitator.name || `Facilitator ${facilitator.id.slice(0, 8)}`,
    });
  } catch (facinetError) {
    // Fallback to relayer if Facinet fails (backward compatibility)
    console.warn(`[payment] Facinet submission failed, falling back to relayer: ${facinetError.message}`);
    
    if (!RELAYER_PRIVATE_KEY) {
      return res.status(503).json({
        error: `Facinet failed: ${facinetError.message}. Relayer not configured for fallback.`,
      });
    }

    try {
      const provider = getProvider(netConfig.rpc);
      const relayer = getSigner(RELAYER_PRIVATE_KEY, provider);
      const usdc = new ethers.Contract(paymentData.usdcAddress, USDC_ERC3009_ABI, relayer);
      const sig = ethers.Signature.from(signature);

      const tx = await usdc.transferWithAuthorization(
        paymentData.message.from,
        paymentData.message.to,
        paymentData.message.value,
        paymentData.message.validAfter,
        paymentData.message.validBefore,
        paymentData.message.nonce,
        sig.v,
        sig.r,
        sig.s
      );

      const receipt = await tx.wait();
      return res.json({ txHash: receipt.hash });
    } catch (relayerError) {
      return res.status(500).json({
        error: `Both Facinet and relayer failed. Facinet: ${facinetError.message}. Relayer: ${relayerError.message}`,
      });
    }
  }
});

// Public config for CLI (no secrets). relayerAddress used for CCTP (non-Fuji payments).
router.get('/config', (_req, res) => {
  return res.json({
    treasuryAddress: TREASURY_ADDRESS || null,
    relayerAddress: RELAYER_ADDRESS || null,
    supportedNetworks: Object.keys(CONTRACTS),
  });
});

export default router;
