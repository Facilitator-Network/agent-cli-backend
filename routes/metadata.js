import { Router } from 'express';
import { ethers } from 'ethers';
import { CONTRACTS, RELAYER_PRIVATE_KEY } from '../lib/constants.js';
import { IdentityRegistryABI } from '../lib/abi.js';

const router = Router();

function getProvider(rpc) {
  return new ethers.JsonRpcProvider(rpc);
}
function getSigner(privateKey, provider) {
  return new ethers.Wallet(privateKey, provider);
}

router.post('/set', async (req, res) => {
  if (!RELAYER_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Relayer not configured' });
  }
  const { agentId, key, value, networkKey } = req.body;
  if (agentId == null || !key || !value || !networkKey) {
    return res.status(400).json({ error: 'agentId, key, value, networkKey required' });
  }

  const netConfig = CONTRACTS[networkKey];
  if (!netConfig) {
    return res.status(400).json({ error: `Unknown network: ${networkKey}` });
  }

  try {
    const provider = getProvider(netConfig.rpc);
    const signer = getSigner(RELAYER_PRIVATE_KEY, provider);
    const registry = new ethers.Contract(netConfig.identityRegistry, IdentityRegistryABI, signer);

    const metadataValue = ethers.hexlify(ethers.toUtf8Bytes(value));
    const tx = await registry.setMetadata(agentId, key, metadataValue);
    const receipt = await tx.wait();

    return res.json({ txHash: receipt.hash });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
