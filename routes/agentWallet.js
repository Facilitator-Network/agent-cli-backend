import { Router } from 'express';
import { ethers } from 'ethers';
import { CONTRACTS, RELAYER_PRIVATE_KEY } from '../lib/constants.js';
import { AgentWalletFactoryABI } from '../lib/abi.js';

const router = Router();

function getProvider(rpc) {
  return new ethers.JsonRpcProvider(rpc);
}
function getSigner(privateKey, provider) {
  return new ethers.Wallet(privateKey, provider);
}

router.post('/deploy', async (req, res) => {
  if (!RELAYER_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Relayer not configured' });
  }
  const { ownerAddress, salt, networkKey } = req.body;
  if (!ownerAddress || !salt || !networkKey) {
    return res.status(400).json({ error: 'ownerAddress, salt, networkKey required' });
  }

  const netConfig = CONTRACTS[networkKey];
  if (!netConfig) {
    return res.status(400).json({ error: `Unknown network: ${networkKey}` });
  }

  try {
    const provider = getProvider(netConfig.rpc);
    const signer = getSigner(RELAYER_PRIVATE_KEY, provider);
    const factory = new ethers.Contract(netConfig.agentWalletFactory, AgentWalletFactoryABI, signer);

    const tx = await factory.deploy(ownerAddress, salt);
    const receipt = await tx.wait();

    let walletAddress = null;
    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed?.name === 'Deployed') {
          walletAddress = parsed.args.wallet;
          break;
        }
      } catch (_) {}
    }

    if (!walletAddress) {
      return res.status(500).json({ error: 'Could not parse wallet address from logs' });
    }

    return res.json({ walletAddress, txHash: receipt.hash });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
