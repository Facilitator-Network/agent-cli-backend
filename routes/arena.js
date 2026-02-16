import { Router } from 'express';
import { ethers } from 'ethers';
import redis from '../lib/redis.js';
import crypto from 'crypto';

const router = Router();

const DEFAULT_ELO = 1200;
const K_FACTOR = 32;

// ---- Helper: verify wallet signature ----
function verifySig(message, signature, expectedAddress) {
  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

// ---- Helper: compute new ELO ratings ----
function computeElo(ratingA, ratingB, scoreA) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;
  return {
    newA: Math.round(ratingA + K_FACTOR * (scoreA - expectedA)),
    newB: Math.round(ratingB + K_FACTOR * (scoreB - expectedB)),
  };
}

// ---- GET /battles → List battles (newest first, optional status filter) ----
router.get('/battles', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  const { status } = req.query; // 'active', 'resolved', or omit for all
  try {
    const battleIds = await redis.zrange('arena:battles', 0, -1, { rev: true });
    const battles = [];

    for (const id of battleIds) {
      const data = await redis.hgetall(`arena:battle:${id}`);
      if (!data || !data.id) continue;
      if (status && data.status !== status) continue;
      // Parse JSON fields
      try { data.agentA = JSON.parse(data.agentA); } catch (_) {}
      try { data.agentB = JSON.parse(data.agentB); } catch (_) {}
      data.votesA = parseInt(data.votesA || '0', 10);
      data.votesB = parseInt(data.votesB || '0', 10);
      battles.push(data);
    }

    return res.json({ battles });
  } catch (e) {
    console.error('Arena list error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- GET /battles/:id → Get single battle ----
router.get('/battles/:id', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  try {
    const data = await redis.hgetall(`arena:battle:${req.params.id}`);
    if (!data || !data.id) return res.status(404).json({ error: 'Battle not found' });

    try { data.agentA = JSON.parse(data.agentA); } catch (_) {}
    try { data.agentB = JSON.parse(data.agentB); } catch (_) {}
    data.votesA = parseInt(data.votesA || '0', 10);
    data.votesB = parseInt(data.votesB || '0', 10);

    // Get voters list
    const voters = await redis.smembers(`arena:battle:${req.params.id}:voters`);
    data.voterCount = voters.length;

    return res.json(data);
  } catch (e) {
    console.error('Arena get error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST /battles → Create a new battle ----
router.post('/battles', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  const { agentA, agentB, prompt, createdBy, durationHours, message, signature } = req.body;

  if (!agentA || !agentB || !prompt || !createdBy) {
    return res.status(400).json({ error: 'agentA, agentB, prompt, and createdBy are required' });
  }

  if (!message || !signature) {
    return res.status(400).json({ error: 'Wallet signature is required' });
  }

  if (!verifySig(message, signature, createdBy)) {
    return res.status(401).json({ error: 'Invalid signature — wallet verification failed' });
  }

  if (agentA.network === agentB.network && agentA.agentId === agentB.agentId) {
    return res.status(400).json({ error: 'Cannot create a battle with the same agent' });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const hours = Math.min(Math.max(parseInt(durationHours || '24', 10), 1), 168); // 1h to 7 days
  const deadline = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  try {
    await redis.hset(`arena:battle:${id}`, {
      id,
      agentA: JSON.stringify(agentA),
      agentB: JSON.stringify(agentB),
      prompt,
      status: 'active',
      createdBy,
      createdAt: now,
      deadline,
      votesA: '0',
      votesB: '0',
      winner: '',
    });

    await redis.zadd('arena:battles', { score: Date.now(), member: id });

    // Initialize ELO for both agents if not present
    const eloKeyA = `${agentA.network}:${agentA.agentId}`;
    const eloKeyB = `${agentB.network}:${agentB.agentId}`;
    const currentA = await redis.zscore('arena:elo', eloKeyA);
    const currentB = await redis.zscore('arena:elo', eloKeyB);
    if (currentA === null) await redis.zadd('arena:elo', { score: DEFAULT_ELO, member: eloKeyA });
    if (currentB === null) await redis.zadd('arena:elo', { score: DEFAULT_ELO, member: eloKeyB });

    return res.json({ ok: true, id, deadline });
  } catch (e) {
    console.error('Arena create error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST /battles/:id/vote → Vote on a battle ----
router.post('/battles/:id/vote', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  const { voter, side, message, signature } = req.body; // side: 'A' or 'B'
  const battleId = req.params.id;

  if (!voter || !side || !['A', 'B'].includes(side)) {
    return res.status(400).json({ error: 'voter and side (A or B) are required' });
  }

  if (!message || !signature) {
    return res.status(400).json({ error: 'Wallet signature is required' });
  }

  if (!verifySig(message, signature, voter)) {
    return res.status(401).json({ error: 'Invalid signature — wallet verification failed' });
  }

  try {
    const battle = await redis.hgetall(`arena:battle:${battleId}`);
    if (!battle || !battle.id) return res.status(404).json({ error: 'Battle not found' });
    if (battle.status !== 'active') return res.status(400).json({ error: 'Battle is no longer active' });

    // Check deadline
    if (new Date(battle.deadline) < new Date()) {
      return res.status(400).json({ error: 'Battle has expired. Awaiting resolution.' });
    }

    // Check if user already voted
    const voterKey = `arena:battle:${battleId}:voters`;
    const alreadyVoted = await redis.sismember(voterKey, voter.toLowerCase());
    if (alreadyVoted) {
      return res.status(400).json({ error: 'You have already voted on this battle' });
    }

    // Record vote
    await redis.sadd(voterKey, voter.toLowerCase());

    const field = side === 'A' ? 'votesA' : 'votesB';
    await redis.hincrby(`arena:battle:${battleId}`, field, 1);

    const newVotesA = parseInt(battle.votesA || '0', 10) + (side === 'A' ? 1 : 0);
    const newVotesB = parseInt(battle.votesB || '0', 10) + (side === 'B' ? 1 : 0);

    return res.json({ ok: true, votesA: newVotesA, votesB: newVotesB });
  } catch (e) {
    console.error('Arena vote error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST /battles/:id/resolve → Resolve a battle (auto or manual) ----
router.post('/battles/:id/resolve', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  const battleId = req.params.id;

  try {
    const battle = await redis.hgetall(`arena:battle:${battleId}`);
    if (!battle || !battle.id) return res.status(404).json({ error: 'Battle not found' });
    if (battle.status === 'resolved') return res.status(400).json({ error: 'Already resolved' });

    const votesA = parseInt(battle.votesA || '0', 10);
    const votesB = parseInt(battle.votesB || '0', 10);
    const totalVotes = votesA + votesB;

    if (totalVotes === 0) {
      await redis.hset(`arena:battle:${battleId}`, { status: 'cancelled', winner: '' });
      return res.json({ ok: true, winner: 'none', reason: 'No votes cast' });
    }

    let agentA, agentB;
    try { agentA = JSON.parse(battle.agentA); } catch (_) { agentA = battle.agentA; }
    try { agentB = JSON.parse(battle.agentB); } catch (_) { agentB = battle.agentB; }

    // Determine winner
    let winner, scoreA;
    if (votesA > votesB) {
      winner = 'A';
      scoreA = 1;
    } else if (votesB > votesA) {
      winner = 'B';
      scoreA = 0;
    } else {
      winner = 'tie';
      scoreA = 0.5;
    }

    // Update ELO
    const eloKeyA = `${agentA.network}:${agentA.agentId}`;
    const eloKeyB = `${agentB.network}:${agentB.agentId}`;
    const currentRatingA = (await redis.zscore('arena:elo', eloKeyA)) || DEFAULT_ELO;
    const currentRatingB = (await redis.zscore('arena:elo', eloKeyB)) || DEFAULT_ELO;

    const { newA, newB } = computeElo(
      Number(currentRatingA),
      Number(currentRatingB),
      scoreA,
    );

    await redis.zadd('arena:elo', { score: newA, member: eloKeyA });
    await redis.zadd('arena:elo', { score: newB, member: eloKeyB });

    // Update battle status
    await redis.hset(`arena:battle:${battleId}`, {
      status: 'resolved',
      winner,
      resolvedAt: new Date().toISOString(),
      eloChangeA: String(newA - Number(currentRatingA)),
      eloChangeB: String(newB - Number(currentRatingB)),
    });

    // Track battle count per agent
    await redis.hincrby('arena:stats', `${eloKeyA}:battles`, 1);
    await redis.hincrby('arena:stats', `${eloKeyB}:battles`, 1);
    if (winner === 'A') await redis.hincrby('arena:stats', `${eloKeyA}:wins`, 1);
    if (winner === 'B') await redis.hincrby('arena:stats', `${eloKeyB}:wins`, 1);

    return res.json({
      ok: true,
      winner,
      votesA,
      votesB,
      elo: { A: newA, B: newB },
      eloChange: { A: newA - Number(currentRatingA), B: newB - Number(currentRatingB) },
    });
  } catch (e) {
    console.error('Arena resolve error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- GET /leaderboard → ELO leaderboard ----
router.get('/leaderboard', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  try {
    // Get all agents sorted by ELO descending
    const entries = await redis.zrange('arena:elo', 0, -1, { rev: true, withScores: true });

    const leaderboard = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const key = typeof entry === 'object' ? entry.value || entry.member : entry;
      const elo = typeof entry === 'object' ? entry.score : 0;

      const [network, agentId] = String(key).split(':');
      if (!network || !agentId) continue;

      // Fetch agent name from agent data
      const agentData = await redis.hgetall(`agent:${network}:${agentId}`);
      const name = agentData?.name || `Agent #${agentId}`;
      const imageUrl = agentData?.imageUrl || '';

      // Get battle stats
      const battlesPlayed = parseInt(
        (await redis.hget('arena:stats', `${network}:${agentId}:battles`)) || '0', 10
      );
      const wins = parseInt(
        (await redis.hget('arena:stats', `${network}:${agentId}:wins`)) || '0', 10
      );

      leaderboard.push({
        rank: leaderboard.length + 1,
        network,
        agentId,
        name,
        imageUrl,
        elo: Number(elo),
        battles: battlesPlayed,
        wins,
        winRate: battlesPlayed > 0 ? Math.round((wins / battlesPlayed) * 100) : 0,
      });
    }

    return res.json({ leaderboard });
  } catch (e) {
    console.error('Arena leaderboard error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

export default router;
