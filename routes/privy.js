import { Router } from 'express';
import { PrivyClient } from '@privy-io/server-auth';

const router = Router();
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

const privy = PRIVY_APP_ID && PRIVY_APP_SECRET
  ? new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET)
  : null;

router.post('/create-wallet', async (req, res) => {
  if (!privy) {
    return res.status(503).json({ error: 'Privy not configured' });
  }
  const { agentId, networkKey } = req.body;
  if (!agentId || !networkKey) {
    return res.status(400).json({ error: 'agentId and networkKey required' });
  }

  const syntheticEmail = `agent-${agentId}-${networkKey}@8004agent.network`;

  try {
    const user = await privy.importUser({
      linkedAccounts: [{ type: 'email', address: syntheticEmail }],
      createEthereumWallet: true,
      createEthereumSmartWallet: true,
    });

    return res.json({
      userId: user.id,
      embeddedWallet: user.wallet?.address || null,
      smartWallet: user.smartWallet?.address || null,
    });
  } catch (e) {
    if (e.message?.includes('already exists') || e.status === 409) {
      try {
        const existingUser = await privy.getUserByEmail(syntheticEmail);
        if (existingUser) {
          return res.json({
            userId: existingUser.id,
            embeddedWallet: existingUser.wallet?.address || null,
            smartWallet: existingUser.smartWallet?.address || null,
          });
        }
      } catch (_) {}
    }
    return res.status(500).json({ error: `Privy wallet creation failed: ${e.message}` });
  }
});

export default router;
