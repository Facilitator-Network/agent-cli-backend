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
  const { agentUrl, networkKey, ownerAddress } = req.body;
  if (!agentUrl || !networkKey) {
    return res.status(400).json({ error: 'agentUrl and networkKey required' });
  }

  const netConfig = CONTRACTS[networkKey];
  if (!netConfig) {
    return res.status(400).json({ error: `Unknown network: ${networkKey}` });
  }

  try {
    const provider = getProvider(netConfig.rpc);
    const signer = getSigner(RELAYER_PRIVATE_KEY, provider);
    const registry = new ethers.Contract(netConfig.identityRegistry, IdentityRegistryABI, signer);
    const relayerAddress = await signer.getAddress();

    const tx = await registry['register(string)'](agentUrl);
    const receipt = await tx.wait();

    let agentId = null;
    for (const evLog of receipt.logs) {
      try {
        const parsed = registry.interface.parseLog(evLog);
        if (parsed?.name === 'Registered') {
          agentId = parsed.args.agentId.toString();
          break;
        }
      } catch (_) {}
    }

    if (!agentId) {
      return res.status(500).json({ error: 'Could not parse Agent ID from logs' });
    }

    if (ownerAddress && ethers.isAddress(ownerAddress) && ownerAddress.toLowerCase() !== relayerAddress.toLowerCase()) {
      const transferTx = await registry.transferFrom(relayerAddress, ownerAddress, agentId);
      await transferTx.wait();
    }

    return res.json({ agentId, txHash: receipt.hash });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
