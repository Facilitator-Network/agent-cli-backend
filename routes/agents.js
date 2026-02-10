import { Router } from 'express';
import redis from '../lib/redis.js';

const router = Router();

// ---- POST / → Store agent data after registration ----
router.post('/', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Marketplace not configured (Upstash not set up)' });

  const {
    agentId, name, url, imageUrl, description, version, author, license,
    mcpEndpoint, a2aEndpoint, skills, domains, metadataStorage, trustModels,
    x402Payment, status, hirePrice, network, ownerAddress, registrationTx,
    registeredAt,
  } = req.body;

  if (!agentId || !network || !name) {
    return res.status(400).json({ error: 'agentId, network, and name are required' });
  }

  const agentKey = `agent:${network}:${agentId}`;

  try {
    await redis.hset(agentKey, {
      agentId: String(agentId),
      name: name || '',
      url: url || '',
      imageUrl: imageUrl || '',
      description: description || '',
      version: version || '1.0.0',
      author: author || '',
      license: license || 'MIT',
      mcpEndpoint: mcpEndpoint || '',
      a2aEndpoint: a2aEndpoint || '',
      skills: JSON.stringify(skills || []),
      domains: JSON.stringify(domains || []),
      metadataStorage: metadataStorage || 'on-chain',
      trustModels: JSON.stringify(trustModels || []),
      x402Payment: String(x402Payment ?? true),
      status: status || 'active',
      hirePrice: String(hirePrice || '0'),
      network,
      ownerAddress: ownerAddress || '',
      registrationTx: registrationTx || '',
      registeredAt: registeredAt || new Date().toISOString(),
    });

    await redis.zadd('platform:agents', {
      score: Date.now(),
      member: `${network}:${agentId}`,
    });

    // Track user's agents
    if (ownerAddress) {
      const userKey = `user:${ownerAddress.toLowerCase()}`;
      const existing = await redis.hget(userKey, 'agents');
      const agentsList = existing ? JSON.parse(existing) : [];
      agentsList.push(`${network}:${agentId}`);
      await redis.hset(userKey, {
        agents: JSON.stringify(agentsList),
        lastSeen: new Date().toISOString(),
      });
    }

    return res.json({ ok: true, agentKey });
  } catch (e) {
    console.error('Upstash store error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- GET / → List all agents (newest first) ----
router.get('/', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Marketplace not configured' });

  try {
    const agentKeys = await redis.zrange('platform:agents', 0, -1, { rev: true });

    const agents = [];
    for (const key of agentKeys) {
      const data = await redis.hgetall(`agent:${key}`);
      if (data && data.name) {
        try { data.skills = JSON.parse(data.skills || '[]'); } catch (_) { data.skills = []; }
        try { data.domains = JSON.parse(data.domains || '[]'); } catch (_) { data.domains = []; }
        try { data.trustModels = JSON.parse(data.trustModels || '[]'); } catch (_) { data.trustModels = []; }
        agents.push(data);
      }
    }

    return res.json({ agents });
  } catch (e) {
    console.error('Upstash list error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- GET /:network/:agentId → Get single agent ----
router.get('/:network/:agentId', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Marketplace not configured' });

  const { network, agentId } = req.params;
  try {
    const data = await redis.hgetall(`agent:${network}:${agentId}`);
    if (!data || !data.name) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    try { data.skills = JSON.parse(data.skills || '[]'); } catch (_) { data.skills = []; }
    try { data.domains = JSON.parse(data.domains || '[]'); } catch (_) { data.domains = []; }
    try { data.trustModels = JSON.parse(data.trustModels || '[]'); } catch (_) { data.trustModels = []; }
    return res.json(data);
  } catch (e) {
    console.error('Upstash get error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

export default router;
