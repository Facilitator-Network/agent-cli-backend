import { Router } from 'express';
import { ethers } from 'ethers';
import { CONTRACTS, RELAYER_ADDRESS, RELAYER_PRIVATE_KEY, TREASURY_ADDRESS } from '../lib/constants.js';
import { USDC_ERC3009_ABI } from '../lib/abi.js';

const router = Router();

function getProvider(rpc) {
  return new ethers.JsonRpcProvider(rpc);
}
function getSigner(privateKey, provider) {
  return new ethers.Wallet(privateKey, provider);
}

router.post('/submit', async (req, res) => {
  if (!RELAYER_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Relayer not configured' });
  }
  const { paymentData, signature, networkKey } = req.body;
  if (!paymentData || !signature || !networkKey) {
    return res.status(400).json({ error: 'paymentData, signature, networkKey required' });
  }

  const netConfig = CONTRACTS[networkKey];
  if (!netConfig) {
    return res.status(400).json({ error: `Unknown network: ${networkKey}` });
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
  } catch (e) {
    return res.status(500).json({ error: e.message });
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
