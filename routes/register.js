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
  const { agentUrl, networkKey, ownerAddress, metadata, deferTransfer } = req.body;
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

    let tx;
    if (metadata && metadata.length > 0) {
      const metadataArgs = metadata.map(m => [
        m.key,
        ethers.hexlify(ethers.toUtf8Bytes(m.value)),
      ]);
      tx = await registry['register(string,(string,bytes)[])'](agentUrl, metadataArgs);
    } else {
      tx = await registry['register(string)'](agentUrl);
    }
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

    // Update tokenURI to point to our NFT metadata endpoint
    try {
      const proto = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const baseUrl = `${proto}://${host}`;
      const metadataUrl = `${baseUrl}/api/nft/${netConfig.chainId}/${agentId}`;
      const uriTx = await registry.setAgentURI(agentId, metadataUrl);
      await uriTx.wait();
    } catch (e) {
      console.warn(`Warning: setAgentURI failed for agent ${agentId}: ${e.message}`);
    }

    // Only transfer NFT if not deferred
    if (!deferTransfer && ownerAddress && ethers.isAddress(ownerAddress) && ownerAddress.toLowerCase() !== relayerAddress.toLowerCase()) {
      const transferTx = await registry.transferFrom(relayerAddress, ownerAddress, agentId);
      await transferTx.wait();
    }

    return res.json({ agentId, txHash: receipt.hash });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Transfer NFT to owner (used after deferred registration)
router.post('/transfer', async (req, res) => {
  if (!RELAYER_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Relayer not configured' });
  }
  const { agentId, ownerAddress, networkKey } = req.body;
  if (agentId == null || !ownerAddress || !networkKey) {
    return res.status(400).json({ error: 'agentId, ownerAddress, networkKey required' });
  }

  const netConfig = CONTRACTS[networkKey];
  if (!netConfig) {
    return res.status(400).json({ error: `Unknown network: ${networkKey}` });
  }

  try {
    const provider = getProvider(netConfig.rpc);
    const signer = getSigner(RELAYER_PRIVATE_KEY, provider);
    const relayerAddress = await signer.getAddress();

    // Use 'pending' so we get the next nonce after any just-confirmed register/setAgentURI txs.
    // Otherwise we can get "nonce too low" if the node's 'latest' view hasn't updated yet.
    const nonce = await provider.getTransactionCount(relayerAddress, 'pending');

    const registry = new ethers.Contract(netConfig.identityRegistry, IdentityRegistryABI, signer);
    const tx = await registry.transferFrom(relayerAddress, ownerAddress, agentId, { nonce });
    const receipt = await tx.wait();
    return res.json({ txHash: receipt.hash });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
