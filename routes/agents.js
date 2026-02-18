import { Router } from 'express';
import { ethers } from 'ethers';
import redis from '../lib/redis.js';
import { CONTRACTS, USDC_ADDRESSES } from '../lib/constants.js';

const router = Router();

// ---- GET /check → Check if agent name or URL is already taken ----
router.get('/check', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Marketplace not configured' });

  const { name, url } = req.query;

  try {
    const result = { nameTaken: false, urlTaken: false };

    if (name) {
      const nameKey = `index:name:${String(name).toLowerCase().trim()}`;
      const existing = await redis.get(nameKey);
      result.nameTaken = !!existing;
    }

    if (url) {
      const urlKey = `index:url:${String(url).toLowerCase().trim()}`;
      const existing = await redis.get(urlKey);
      result.urlTaken = !!existing;
    }

    return res.json(result);
  } catch (e) {
    console.error('Upstash check error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST / → Store agent data after registration ----
router.post('/', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Marketplace not configured (Upstash not set up)' });

  const {
    agentId, name, url, imageUrl, description, version, author, license,
    mcpEndpoint, a2aEndpoint, skills, domains, metadataStorage, trustModels,
    x402Payment, status, hirePrice, network, ownerAddress, registrationTx,
    registeredAt, agentWalletAddress, circleWalletId,
  } = req.body;

  if (!agentId || !network || !name) {
    return res.status(400).json({ error: 'agentId, network, and name are required' });
  }

  const agentKey = `agent:${network}:${agentId}`;

  try {
    // Index name and URL for uniqueness (only on first network to avoid duplicates)
    if (name) {
      const nameKey = `index:name:${name.toLowerCase().trim()}`;
      await redis.set(nameKey, `${network}:${agentId}`);
    }
    if (url) {
      const urlKey = `index:url:${url.toLowerCase().trim()}`;
      await redis.set(urlKey, `${network}:${agentId}`);
    }

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
      agentWalletAddress: agentWalletAddress || '',
      circleWalletId: circleWalletId || '',
    });

    await redis.zadd('platform:agents', {
      score: Date.now(),
      member: `${network}:${agentId}`,
    });

    // Track user's agents
    if (ownerAddress) {
      const userKey = `user:${ownerAddress.toLowerCase()}`;
      const existing = await redis.hget(userKey, 'agents');
      let agentsList = [];
      if (existing) {
        try { agentsList = JSON.parse(existing); } catch (_) { agentsList = [existing]; }
        if (!Array.isArray(agentsList)) agentsList = [agentsList];
      }
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

// ---- GET /hires/:address → Get agents hired by a user (via USDC Transfer events) ----
router.get('/hires/:address', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Marketplace not configured' });

  const userAddress = req.params.address;
  if (!ethers.isAddress(userAddress)) {
    return res.status(400).json({ error: 'Invalid address' });
  }

  try {
    const agentKeys = await redis.zrange('platform:agents', 0, -1, { rev: true });

    // Build map of agentWalletAddress → agent data
    const walletToAgent = {};
    for (const key of agentKeys) {
      const data = await redis.hgetall(`agent:${key}`);
      if (data && data.agentWalletAddress) {
        walletToAgent[data.agentWalletAddress.toLowerCase()] = data;
      }
    }

    if (Object.keys(walletToAgent).length === 0) {
      return res.json({ hires: [] });
    }

    // Query USDC Transfer events on Fuji where from = userAddress
    const fujiRpc = CONTRACTS.fuji?.rpc;
    const usdcAddress = USDC_ADDRESSES.fuji;
    if (!fujiRpc || !usdcAddress) {
      return res.json({ hires: [] });
    }

    const provider = new ethers.JsonRpcProvider(fujiRpc);
    const usdc = new ethers.Contract(usdcAddress, [
      'event Transfer(address indexed from, address indexed to, uint256 value)',
    ], provider);

    const filter = usdc.filters.Transfer(userAddress, null);
    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - 100000);

    const logs = await usdc.queryFilter(filter, fromBlock, 'latest');

    const hiredSet = new Set();
    const hires = [];

    for (const log of logs) {
      const toAddr = log.args.to.toLowerCase();
      if (walletToAgent[toAddr] && !hiredSet.has(toAddr)) {
        hiredSet.add(toAddr);
        const agent = { ...walletToAgent[toAddr] };
        try { agent.skills = JSON.parse(agent.skills || '[]'); } catch { agent.skills = []; }
        try { agent.domains = JSON.parse(agent.domains || '[]'); } catch { agent.domains = []; }
        try { agent.trustModels = JSON.parse(agent.trustModels || '[]'); } catch { agent.trustModels = []; }
        hires.push({
          ...agent,
          paymentAmount: Number(log.args.value) / 1e6,
          paymentTxHash: log.transactionHash,
        });
      }
    }

    return res.json({ hires });
  } catch (e) {
    console.error('Hires query error:', e.message);
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
