import { Router } from 'express';
import crypto from 'crypto';
import redis from '../lib/redis.js';

const router = Router();

// ---- Pricing plan calculator ----
function computePlans(perCallPrice) {
  const p = parseFloat(perCallPrice) || 0;
  if (p <= 0) return null;
  return {
    single:   { calls: 1,    days: 1,   price: +(p).toFixed(6),                       label: 'Single Call' },
    daily:    { calls: 50,   days: 1,   price: +(p * 50 * 0.8).toFixed(6),            label: 'Day Pass' },
    monthly:  { calls: 1500, days: 30,  price: +(p * 1500 * 0.6).toFixed(6),          label: 'Monthly' },
    biannual: { calls: 9000, days: 180, price: +(p * 9000 * 0.45).toFixed(6),         label: '6 Months' },
  };
}

// ---- GET /plans/:network/:agentId → Compute pricing plans from per-call price ----
router.get('/plans/:network/:agentId', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Not configured' });

  const { network, agentId } = req.params;
  try {
    const agent = await redis.hgetall(`agent:${network}:${agentId}`);
    if (!agent || !agent.name) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const perCallPrice = parseFloat(agent.hirePrice || '0');
    if (perCallPrice <= 0) {
      return res.json({ free: true, plans: null });
    }

    return res.json({ free: false, plans: computePlans(perCallPrice), perCallPrice });
  } catch (e) {
    console.error('Plans error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST / → Record a new hire after payment ----
router.post('/', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Not configured' });

  const {
    network, agentId, buyerAddress, plan, paymentTxHash,
    callsTotal, daysValid, pricePaid,
  } = req.body;

  if (!network || !agentId || !buyerAddress || !plan || !paymentTxHash) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const hireId = crypto.randomBytes(8).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (daysValid || 1) * 24 * 60 * 60 * 1000);

    const hireData = {
      hireId,
      network,
      agentId: String(agentId),
      buyerAddress: buyerAddress.toLowerCase(),
      plan,
      callsTotal: Number(callsTotal) || 1,
      callsUsed: 0,
      daysValid: Number(daysValid) || 1,
      pricePaid: String(pricePaid || '0'),
      paymentTxHash,
      status: 'active',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    // Store hire record
    const hireKey = `hire:${hireId}`;
    await redis.hset(hireKey, hireData);

    // Index by buyer address
    await redis.zadd(`hires:${buyerAddress.toLowerCase()}`, {
      score: Date.now(),
      member: hireId,
    });

    // Index by agent
    await redis.zadd(`hires:agent:${network}:${agentId}`, {
      score: Date.now(),
      member: hireId,
    });

    return res.json({ ok: true, hireId, hire: hireData });
  } catch (e) {
    console.error('Hire record error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- GET /my/:address → Get all hires for a buyer ----
router.get('/my/:address', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Not configured' });

  const address = req.params.address.toLowerCase();

  try {
    const hireIds = await redis.zrange(`hires:${address}`, 0, -1, { rev: true });
    const hires = [];

    for (const hireId of hireIds) {
      const data = await redis.hgetall(`hire:${hireId}`);
      if (data && data.hireId) {
        // Check expiry
        if (new Date(data.expiresAt) < new Date() && data.status === 'active') {
          data.status = 'expired';
          await redis.hset(`hire:${hireId}`, { status: 'expired' });
        }
        // Attach agent info
        const agent = await redis.hgetall(`agent:${data.network}:${data.agentId}`);
        if (agent && agent.name) {
          try { agent.skills = JSON.parse(agent.skills || '[]'); } catch { agent.skills = []; }
          data.agent = agent;
        }
        hires.push(data);
      }
    }

    return res.json({ hires });
  } catch (e) {
    console.error('List hires error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- GET /status/:hireId → Get single hire status ----
router.get('/status/:hireId', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Not configured' });

  try {
    const data = await redis.hgetall(`hire:${req.params.hireId}`);
    if (!data || !data.hireId) {
      return res.status(404).json({ error: 'Hire not found' });
    }

    // Check expiry
    if (new Date(data.expiresAt) < new Date() && data.status === 'active') {
      data.status = 'expired';
      await redis.hset(`hire:${data.hireId}`, { status: 'expired' });
    }

    return res.json(data);
  } catch (e) {
    console.error('Hire status error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- GET /active/:address/:network/:agentId → Check if user has active hire for agent ----
router.get('/active/:address/:network/:agentId', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Not configured' });

  const { address, network, agentId } = req.params;
  const addr = address.toLowerCase();

  try {
    const hireIds = await redis.zrange(`hires:${addr}`, 0, -1, { rev: true });

    for (const hireId of hireIds) {
      const data = await redis.hgetall(`hire:${hireId}`);
      if (
        data &&
        data.network === network &&
        data.agentId === String(agentId) &&
        data.status === 'active'
      ) {
        // Check expiry
        if (new Date(data.expiresAt) < new Date()) {
          data.status = 'expired';
          await redis.hset(`hire:${hireId}`, { status: 'expired' });
          continue;
        }
        // Check calls
        if (Number(data.callsUsed) >= Number(data.callsTotal)) {
          data.status = 'exhausted';
          await redis.hset(`hire:${hireId}`, { status: 'exhausted' });
          continue;
        }
        return res.json({ active: true, hire: data });
      }
    }

    return res.json({ active: false, hire: null });
  } catch (e) {
    console.error('Active hire check error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

export default router;
