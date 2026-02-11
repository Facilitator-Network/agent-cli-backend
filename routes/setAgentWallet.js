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

// POST / — submit a pre-signed setAgentWallet (legacy, signature provided by caller)
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

// POST /relayer — relayer signs as current owner and submits setAgentWallet
// Used when relayer still owns the NFT (before transfer to user)
router.post('/relayer', async (req, res) => {
  if (!RELAYER_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Relayer not configured' });
  }
  const { agentId, agentWalletAddress, networkKey } = req.body;
  if (agentId == null || !agentWalletAddress || !networkKey) {
    return res.status(400).json({ error: 'agentId, agentWalletAddress, networkKey required' });
  }

  const netConfig = CONTRACTS[networkKey];
  if (!netConfig) {
    return res.status(400).json({ error: `Unknown network: ${networkKey}` });
  }

  try {
    const provider = getProvider(netConfig.rpc);
    const relayerWallet = getSigner(RELAYER_PRIVATE_KEY, provider);
    const registry = new ethers.Contract(netConfig.identityRegistry, IdentityRegistryABI, relayerWallet);

    // Get EIP-712 domain from contract
    const domainData = await registry.eip712Domain();
    const domain = {
      name: domainData[1],
      version: domainData[2],
      chainId: domainData[3],
      verifyingContract: domainData[4],
    };

    const types = {
      SetAgentWallet: [
        { name: 'agentId', type: 'uint256' },
        { name: 'newWallet', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    // Use on-chain block timestamp to avoid clock drift issues
    const block = await provider.getBlock('latest');
    const deadline = block.timestamp + 60; // 60 seconds from current block

    // Relayer signs as current owner
    const signature = await relayerWallet.signTypedData(domain, types, {
      agentId: BigInt(agentId),
      newWallet: agentWalletAddress,
      deadline: BigInt(deadline),
    });

    // Submit the transaction
    const tx = await registry.setAgentWallet(agentId, agentWalletAddress, deadline, signature);
    const receipt = await tx.wait();
    return res.json({ txHash: receipt.hash });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
