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

router.post('/', async (req, res) => {
  if (!RELAYER_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Relayer not configured' });
  }
  const { agentId, newWallet, deadline, signature, networkKey } = req.body;
  if (agentId == null || !newWallet || !deadline || !signature || !networkKey) {
    return res.status(400).json({ error: 'agentId, newWallet, deadline, signature, networkKey required' });
  }

  const netConfig = CONTRACTS[networkKey];
  if (!netConfig) {
    return res.status(400).json({ error: `Unknown network: ${networkKey}` });
  }

  try {
    const provider = getProvider(netConfig.rpc);
    const signer = getSigner(RELAYER_PRIVATE_KEY, provider);
    const registry = new ethers.Contract(netConfig.identityRegistry, IdentityRegistryABI, signer);

    const tx = await registry.setAgentWallet(agentId, newWallet, deadline, signature);
    const receipt = await tx.wait();
    return res.json({ txHash: receipt.hash });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
