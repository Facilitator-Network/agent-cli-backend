import { Router } from 'express';
import { ethers } from 'ethers';
import { circleClient, CIRCLE_WALLET_SET_ID } from '../lib/circle.js';
import { CONTRACTS, RELAYER_PRIVATE_KEY } from '../lib/constants.js';
import redis from '../lib/redis.js';

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
    // Create a single EOA wallet on AVAX-FUJI (payment chain — address works on all EVM chains)
    const response = await circleClient.createWallets({
      accountType: 'EOA',
      blockchains: ['AVAX-FUJI'],
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

// POST /withdraw — Withdraw USDC from agent's Circle wallet to an external address
router.post('/withdraw', async (req, res) => {
  if (!circleClient) {
    return res.status(503).json({ error: 'Circle not configured' });
  }
  if (!RELAYER_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Relayer not configured (needed for gas funding)' });
  }

  const { agentId, network, toAddress, amount, ownerAddress, usdcAddress } = req.body;

  if (!agentId || !network || !toAddress || !amount || !ownerAddress || !usdcAddress) {
    return res.status(400).json({
      error: 'agentId, network, toAddress, amount, ownerAddress, usdcAddress are all required',
    });
  }

  if (!ethers.isAddress(toAddress)) {
    return res.status(400).json({ error: 'Invalid toAddress' });
  }

  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  // ---- 1. Look up agent in Upstash and verify ownership ----
  if (!redis) {
    return res.status(503).json({ error: 'Redis not configured' });
  }

  const agentKey = `agent:${network}:${agentId}`;
  let agentData;
  try {
    agentData = await redis.hgetall(agentKey);
  } catch (e) {
    return res.status(500).json({ error: `Failed to look up agent: ${e.message}` });
  }

  if (!agentData || !agentData.name) {
    return res.status(404).json({ error: 'Agent not found in marketplace' });
  }

  if (agentData.ownerAddress?.toLowerCase() !== ownerAddress.toLowerCase()) {
    return res.status(403).json({ error: 'Owner address does not match agent registration' });
  }

  const circleWalletId = agentData.circleWalletId;
  const agentWalletAddress = agentData.agentWalletAddress;

  if (!circleWalletId) {
    return res.status(400).json({ error: 'Agent does not have a Circle wallet ID' });
  }

  // ---- 2. Fund gas from relayer (send small AVAX to agent wallet on Fuji) ----
  const fujiConfig = CONTRACTS.fuji;
  try {
    const provider = new ethers.JsonRpcProvider(fujiConfig.rpc);
    const relayer = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

    // Check if agent wallet already has enough gas
    const balance = await provider.getBalance(agentWalletAddress);
    const gasThreshold = ethers.parseEther('0.005');

    if (balance < gasThreshold) {
      const gasTx = await relayer.sendTransaction({
        to: agentWalletAddress,
        value: ethers.parseEther('0.01'), // 0.01 AVAX for gas
      });
      await gasTx.wait();
    }
  } catch (e) {
    return res.status(500).json({ error: `Failed to fund gas: ${e.message}` });
  }

  // ---- 3. Execute USDC transfer via Circle SDK ----
  // Convert amount to smallest units (USDC has 6 decimals)
  const rawAmount = Math.floor(parsedAmount * 1e6).toString();

  let circleTxId;
  try {
    const response = await circleClient.createContractExecutionTransaction({
      walletId: circleWalletId,
      contractAddress: usdcAddress,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [toAddress, rawAmount],
      fee: {
        type: 'level',
        config: {
          feeLevel: 'MEDIUM',
        },
      },
    });

    circleTxId = response.data?.id;
    if (!circleTxId) {
      return res.status(500).json({ error: 'Circle did not return a transaction ID' });
    }
  } catch (e) {
    return res.status(500).json({ error: `Circle contract execution failed: ${e.message}` });
  }

  // ---- 4. Poll for transaction completion ----
  let txHash = null;
  let finalState = null;
  const maxAttempts = 30;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const statusResponse = await circleClient.getTransaction({ id: circleTxId });
      const tx = statusResponse.data;

      if (tx?.state === 'CONFIRMED') {
        txHash = tx.txHash;
        finalState = 'CONFIRMED';
        break;
      }
      if (tx?.state === 'FAILED' || tx?.state === 'DENIED' || tx?.state === 'CANCELLED') {
        finalState = tx.state;
        break;
      }
    } catch (_) {
      // Continue polling
    }
  }

  if (finalState === 'CONFIRMED' && txHash) {
    return res.json({
      ok: true,
      txHash,
      circleTxId,
      amount: parsedAmount,
      toAddress,
      fromWallet: agentWalletAddress,
    });
  } else if (finalState) {
    return res.status(500).json({
      error: `Circle transaction ${finalState.toLowerCase()}`,
      circleTxId,
    });
  } else {
    // Timed out but transaction may still complete
    return res.json({
      ok: true,
      txHash: null,
      circleTxId,
      message: 'Transaction submitted but not yet confirmed. Check Circle dashboard.',
      amount: parsedAmount,
      toAddress,
      fromWallet: agentWalletAddress,
    });
  }
});

export default router;
