import { Router } from 'express';
import { circleClient, CIRCLE_WALLET_SET_ID } from '../lib/circle.js';

const router = Router();

// POST /create-wallet — Create a Circle EOA wallet for an agent
router.post('/create-wallet', async (req, res) => {
  if (!circleClient) {
    return res.status(503).json({ error: 'Circle not configured. Set CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID.' });
  }
  if (!CIRCLE_WALLET_SET_ID) {
    return res.status(503).json({ error: 'CIRCLE_WALLET_SET_ID not configured.' });
  }

  const { agentId } = req.body;
  if (!agentId) {
    return res.status(400).json({ error: 'agentId is required' });
  }

  try {
    // Create a single EOA wallet on ETH-SEPOLIA (address works on all EVM chains)
    const response = await circleClient.createWallets({
      accountType: 'EOA',
      blockchains: ['ETH-SEPOLIA'],
      count: 1,
      walletSetId: CIRCLE_WALLET_SET_ID,
      metadata: [{ name: 'agentId', refId: String(agentId) }],
    });

    const wallet = response.data?.wallets?.[0];
    if (!wallet) {
      return res.status(500).json({ error: 'Circle wallet creation returned no wallet' });
    }

    return res.json({
      walletId: wallet.id,
      address: wallet.address,
      blockchain: wallet.blockchain,
      state: wallet.state,
    });
  } catch (e) {
    console.error('Circle wallet creation error:', e.message);
    return res.status(500).json({ error: `Circle wallet creation failed: ${e.message}` });
  }
});

export default router;
