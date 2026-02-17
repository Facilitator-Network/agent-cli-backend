import { Router } from 'express';
import { ethers } from 'ethers';
import redis from '../lib/redis.js';
import { USDC_ADDRESSES, FACINET_API_URL } from '../lib/constants.js';
import crypto from 'crypto';

const router = Router();

// ---- Config ----
const ADMIN_WALLET = (process.env.ADMIN_WALLET || '').toLowerCase();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const FUJI_RPC = process.env.AVALANCHE_FUJI_RPC_URL || 'https://api.avax-test.network/ext/bc/C/rpc';
const FUJI_CHAIN_ID = 43113;
const FUJI_NETWORK = 'avalanche-fuji';
const USDC_ADDRESS = USDC_ADDRESSES.fuji;
const USDC_DECIMALS = 6;
const DEFAULT_ELO = 1200;
const K_FACTOR = 32;
const AGENT_CALL_TIMEOUT = 30000; // 30s

const USDC_TRANSFER_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

// ---- Helpers ----
function verifySig(message, signature, expectedAddress) {
  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

function isAdmin(address) {
  return ADMIN_WALLET && address.toLowerCase() === ADMIN_WALLET;
}

function toUsdcUnits(amount) {
  return BigInt(Math.round(parseFloat(amount) * Math.pow(10, USDC_DECIMALS)));
}

function fromUsdcUnits(units) {
  return Number(units) / Math.pow(10, USDC_DECIMALS);
}

function computeElo(ratingA, ratingB, scoreA) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;
  return {
    newA: Math.round(ratingA + K_FACTOR * (scoreA - expectedA)),
    newB: Math.round(ratingB + K_FACTOR * (scoreB - expectedB)),
  };
}

// ---- Facinet helpers ----
async function getFacilitators() {
  const res = await fetch(
    `${FACINET_API_URL}/api/facilitator/list?network=${FUJI_NETWORK}&chainId=${FUJI_CHAIN_ID}`,
    { headers: { 'User-Agent': 'Facinet-Backend/1.0' } }
  );
  const data = await res.json();
  if (!data.success || !Array.isArray(data.facilitators)) return [];
  return data.facilitators.filter(f => {
    if (f.status !== 'active') return false;
    if (f.network && f.network !== FUJI_NETWORK) return false;
    if (f.chainId !== undefined && f.chainId !== FUJI_CHAIN_ID) return false;
    if (!f.network && f.chainId === undefined) return false;
    return true;
  });
}

async function selectFacilitator() {
  const facilitators = await getFacilitators();
  if (facilitators.length === 0) throw new Error('No active facilitators on Avalanche Fuji');
  const f = facilitators[Math.floor(Math.random() * facilitators.length)];
  return { id: f.id, name: f.name || `Facilitator ${f.id.slice(0, 8)}`, wallet: f.facilitatorWallet };
}

async function facinetTransferUsdc(facilitator, toAddress, amount) {
  const payload = {
    facilitatorId: facilitator.id,
    network: FUJI_NETWORK,
    chainId: FUJI_CHAIN_ID,
    contractAddress: USDC_ADDRESS,
    functionName: 'transfer',
    functionArgs: [toAddress, amount.toString()],
    abi: [
      {
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        name: 'transfer',
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
        type: 'function',
      },
    ],
  };

  const res = await fetch(`${FACINET_API_URL}/api/x402/execute-contract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Network': FUJI_NETWORK,
      'X-Chain-Id': FUJI_CHAIN_ID.toString(),
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data.error || data.message || `USDC transfer failed (HTTP ${res.status})`);
  }
  return data.txHash;
}

// ---- Verify USDC payment on-chain ----
async function verifyUsdcPayment(txHash, expectedFrom, expectedTo, expectedAmount) {
  const provider = new ethers.JsonRpcProvider(FUJI_RPC);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) return false;

  const iface = new ethers.Interface(USDC_TRANSFER_ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (
        parsed.name === 'Transfer' &&
        parsed.args[0].toLowerCase() === expectedFrom.toLowerCase() &&
        parsed.args[1].toLowerCase() === expectedTo.toLowerCase() &&
        BigInt(parsed.args[2]) >= BigInt(expectedAmount)
      ) {
        return true;
      }
    } catch {}
  }
  return false;
}

// ---- Gemini API ----
async function scoreWithGemini(category, prompt, agentResponse, latencyMs) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const systemPrompt = `You are an expert AI agent evaluator. Score the following agent response to a challenge prompt.

Category: ${category}
Challenge Prompt: "${prompt}"
Agent Response: "${agentResponse}"
Response Latency: ${latencyMs}ms

Score each criterion from 0 to the max points:
- accuracy (0-20): Is the answer factually correct and relevant?
- completeness (0-15): Does it fully address the prompt?
- domainExpertise (0-20): Depth of knowledge in the category
- reasoning (0-15): Logical, step-by-step thinking
- safety (0-10): Properly handles sensitive or harmful content
- clarity (0-10): Well-structured, readable, concise
- edgeCases (0-10): Handles ambiguity gracefully

Return ONLY valid JSON with no markdown:
{"accuracy":0,"completeness":0,"domainExpertise":0,"reasoning":0,"safety":0,"clarity":0,"edgeCases":0,"total":0,"feedback":"1 sentence explanation"}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: systemPrompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
    }
  );

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini returned no valid JSON');

  const scores = JSON.parse(jsonMatch[0]);
  scores.total =
    (scores.accuracy || 0) +
    (scores.completeness || 0) +
    (scores.domainExpertise || 0) +
    (scores.reasoning || 0) +
    (scores.safety || 0) +
    (scores.clarity || 0) +
    (scores.edgeCases || 0);

  return scores;
}

// ---- Call agent endpoint ----
async function callAgentEndpoint(endpoint, prompt) {
  if (!endpoint) return { response: '', latency: 0, error: 'No endpoint configured' };

  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_CALL_TIMEOUT);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, message: prompt, query: prompt }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latency = Date.now() - start;

    const contentType = res.headers.get('content-type') || '';
    let response;
    if (contentType.includes('json')) {
      const data = await res.json();
      response = data.response || data.result || data.text || data.message || data.output || JSON.stringify(data);
    } else {
      response = await res.text();
    }

    return { response: String(response).slice(0, 5000), latency, error: null };
  } catch (e) {
    clearTimeout(timeout);
    return { response: '', latency: Date.now() - start, error: e.message };
  }
}

// ======== ROUTES ========

// ---- GET /events → List all events ----
router.get('/events', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  const { status } = req.query;
  try {
    const eventIds = await redis.zrange('arena:events', 0, -1, { rev: true });
    const events = [];

    for (const id of eventIds) {
      const data = await redis.hgetall(`arena:event:${id}`);
      if (!data || !data.id) continue;
      if (status && data.status !== status) continue;
      try { data.participants = JSON.parse(data.participants || '[]'); } catch { data.participants = []; }
      try { data.prompts = JSON.parse(data.prompts || '[]'); } catch { data.prompts = []; }
      try { data.votes = JSON.parse(data.votes || '{}'); } catch { data.votes = {}; }
      try { data.scores = JSON.parse(data.scores || '{}'); } catch { data.scores = {}; }
      try { data.results = JSON.parse(data.results || '{}'); } catch { data.results = {}; }
      try { data.facilitator = JSON.parse(data.facilitator || '{}'); } catch { data.facilitator = {}; }
      // Hide prompts during registration phase
      if (data.status === 'registration') data.prompts = data.prompts.map(() => '(hidden)');
      events.push(data);
    }

    return res.json({ events });
  } catch (e) {
    console.error('Arena events list error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- GET /events/:id → Get single event ----
router.get('/events/:id', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  try {
    const data = await redis.hgetall(`arena:event:${req.params.id}`);
    if (!data || !data.id) return res.status(404).json({ error: 'Event not found' });
    try { data.participants = JSON.parse(data.participants || '[]'); } catch { data.participants = []; }
    try { data.prompts = JSON.parse(data.prompts || '[]'); } catch { data.prompts = []; }
    try { data.votes = JSON.parse(data.votes || '{}'); } catch { data.votes = {}; }
    try { data.scores = JSON.parse(data.scores || '{}'); } catch { data.scores = {}; }
    try { data.results = JSON.parse(data.results || '{}'); } catch { data.results = {}; }
    try { data.facilitator = JSON.parse(data.facilitator || '{}'); } catch { data.facilitator = {}; }
    if (data.status === 'registration') data.prompts = data.prompts.map(() => '(hidden)');
    return res.json(data);
  } catch (e) {
    console.error('Arena event get error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST /events → Create event (admin only) ----
router.post('/events', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  const { title, category, description, entryFee, maxParticipants, prompts, registrationDeadline, battleStart, battleEnd, createdBy, message, signature } = req.body;

  if (!title || !category || !entryFee || !prompts || !createdBy || !message || !signature) {
    return res.status(400).json({ error: 'title, category, entryFee, prompts, createdBy, message, and signature required' });
  }

  if (!verifySig(message, signature, createdBy)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (!isAdmin(createdBy)) {
    return res.status(403).json({ error: 'Only admin can create events' });
  }

  if (!Array.isArray(prompts) || prompts.length === 0) {
    return res.status(400).json({ error: 'At least one challenge prompt is required' });
  }

  try {
    // Select facilitator for this event — all payments go to this wallet
    const facilitator = await selectFacilitator();

    const id = crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();

    await redis.hset(`arena:event:${id}`, {
      id,
      title,
      category: category || 'General',
      description: description || '',
      entryFee: String(entryFee),
      maxParticipants: String(maxParticipants || 16),
      prompts: JSON.stringify(prompts),
      status: 'registration',
      createdBy,
      createdAt: now,
      registrationDeadline: registrationDeadline || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      battleStart: battleStart || '',
      battleEnd: battleEnd || '',
      participants: JSON.stringify([]),
      votes: JSON.stringify({}),
      scores: JSON.stringify({}),
      results: JSON.stringify({}),
      facilitator: JSON.stringify(facilitator),
    });

    await redis.zadd('arena:events', { score: Date.now(), member: id });

    return res.json({ ok: true, id, facilitatorWallet: facilitator.wallet });
  } catch (e) {
    console.error('Arena event create error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST /events/:id/register → Register agent for event ----
router.post('/events/:id/register', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  const { agentId, network, name, ownerAddress, endpoint, paymentTxHash, message, signature } = req.body;
  const eventId = req.params.id;

  if (!agentId || !network || !name || !ownerAddress || !paymentTxHash || !message || !signature) {
    return res.status(400).json({ error: 'agentId, network, name, ownerAddress, paymentTxHash, message, and signature required' });
  }

  if (!verifySig(message, signature, ownerAddress)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const event = await redis.hgetall(`arena:event:${eventId}`);
    if (!event || !event.id) return res.status(404).json({ error: 'Event not found' });
    if (event.status !== 'registration') return res.status(400).json({ error: 'Registration is closed' });

    const participants = JSON.parse(event.participants || '[]');
    const maxP = parseInt(event.maxParticipants || '16', 10);

    if (participants.length >= maxP) {
      return res.status(400).json({ error: 'Event is full' });
    }

    // Check if agent already registered
    if (participants.some(p => p.agentId === agentId && p.network === network)) {
      return res.status(400).json({ error: 'Agent already registered for this event' });
    }

    // Verify USDC payment on-chain
    const facilitator = JSON.parse(event.facilitator || '{}');
    const entryFeeUnits = toUsdcUnits(event.entryFee);
    const paymentValid = await verifyUsdcPayment(paymentTxHash, ownerAddress, facilitator.wallet, entryFeeUnits);

    if (!paymentValid) {
      return res.status(400).json({ error: 'Payment not verified on-chain. Ensure correct amount sent to facilitator wallet.' });
    }

    participants.push({
      agentId,
      network,
      name,
      ownerAddress,
      endpoint: endpoint || '',
      paymentTxHash,
      registeredAt: new Date().toISOString(),
    });

    await redis.hset(`arena:event:${eventId}`, { participants: JSON.stringify(participants) });

    return res.json({ ok: true, participantCount: participants.length });
  } catch (e) {
    console.error('Arena register error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST /events/:id/status → Update event status (admin) ----
router.post('/events/:id/status', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  const { status, createdBy, message, signature } = req.body;

  if (!verifySig(message, signature, createdBy)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (!isAdmin(createdBy)) {
    return res.status(403).json({ error: 'Only admin can update event status' });
  }

  const validStatuses = ['registration', 'voting', 'battle', 'judging', 'completed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    await redis.hset(`arena:event:${req.params.id}`, { status });
    return res.json({ ok: true, status });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST /events/:id/vote → Vote for an agent ----
router.post('/events/:id/vote', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  const { voter, agentKey, message, signature } = req.body; // agentKey = "network:agentId"
  const eventId = req.params.id;

  if (!voter || !agentKey || !message || !signature) {
    return res.status(400).json({ error: 'voter, agentKey, message, and signature required' });
  }

  if (!verifySig(message, signature, voter)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const event = await redis.hgetall(`arena:event:${eventId}`);
    if (!event || !event.id) return res.status(404).json({ error: 'Event not found' });
    if (event.status !== 'voting') return res.status(400).json({ error: 'Voting is not open' });

    // Check voter hasn't already voted
    const voterSetKey = `arena:event:${eventId}:voters`;
    const alreadyVoted = await redis.sismember(voterSetKey, voter.toLowerCase());
    if (alreadyVoted) {
      return res.status(400).json({ error: 'You have already voted in this event' });
    }

    // Verify agentKey is a participant
    const participants = JSON.parse(event.participants || '[]');
    const isParticipant = participants.some(p => `${p.network}:${p.agentId}` === agentKey);
    if (!isParticipant) {
      return res.status(400).json({ error: 'Agent is not a participant in this event' });
    }

    // Record vote
    await redis.sadd(voterSetKey, voter.toLowerCase());

    const votes = JSON.parse(event.votes || '{}');
    if (!votes[agentKey]) votes[agentKey] = [];
    votes[agentKey].push(voter.toLowerCase());

    await redis.hset(`arena:event:${eventId}`, { votes: JSON.stringify(votes) });

    return res.json({ ok: true });
  } catch (e) {
    console.error('Arena vote error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST /events/:id/judge → Run Gemini judging (admin) ----
router.post('/events/:id/judge', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  const { createdBy, message, signature } = req.body;

  if (!verifySig(message, signature, createdBy)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (!isAdmin(createdBy)) {
    return res.status(403).json({ error: 'Only admin can trigger judging' });
  }

  const eventId = req.params.id;

  try {
    const event = await redis.hgetall(`arena:event:${eventId}`);
    if (!event || !event.id) return res.status(404).json({ error: 'Event not found' });

    // Set status to judging
    await redis.hset(`arena:event:${eventId}`, { status: 'judging' });

    const participants = JSON.parse(event.participants || '[]');
    const prompts = JSON.parse(event.prompts || '[]');
    const category = event.category || 'General';

    if (participants.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 participants to judge' });
    }

    const allScores = {};

    for (const participant of participants) {
      const agentKey = `${participant.network}:${participant.agentId}`;
      const endpoint = participant.endpoint || '';
      const promptScores = [];
      let totalScore = 0;
      let totalLatency = 0;

      for (let i = 0; i < prompts.length; i++) {
        const promptText = prompts[i];
        console.log(`Judging ${participant.name} on prompt ${i + 1}/${prompts.length}...`);

        // Call agent endpoint
        const { response, latency, error: callError } = await callAgentEndpoint(endpoint, promptText);

        if (callError || !response) {
          promptScores.push({
            prompt: i + 1,
            latency: latency || 0,
            error: callError || 'No response',
            accuracy: 0, completeness: 0, domainExpertise: 0, reasoning: 0,
            safety: 0, clarity: 0, edgeCases: 0, total: 0,
            feedback: `Agent failed: ${callError || 'no response'}`,
          });
          continue;
        }

        totalLatency += latency;

        // Score with Gemini
        try {
          const geminiScores = await scoreWithGemini(category, promptText, response, latency);
          promptScores.push({
            prompt: i + 1,
            latency,
            ...geminiScores,
          });
          totalScore += geminiScores.total;
        } catch (geminiErr) {
          console.error(`Gemini scoring failed for ${participant.name} prompt ${i + 1}:`, geminiErr.message);
          promptScores.push({
            prompt: i + 1,
            latency,
            accuracy: 0, completeness: 0, domainExpertise: 0, reasoning: 0,
            safety: 0, clarity: 0, edgeCases: 0, total: 0,
            feedback: `Gemini error: ${geminiErr.message}`,
          });
        }
      }

      const avgScore = prompts.length > 0 ? Math.round((totalScore / prompts.length) * 10) / 10 : 0;
      const avgLatency = prompts.length > 0 ? Math.round(totalLatency / prompts.length) : 0;

      allScores[agentKey] = {
        name: participant.name,
        promptScores,
        totalScore,
        avgScore,
        avgLatency,
      };
    }

    await redis.hset(`arena:event:${eventId}`, { scores: JSON.stringify(allScores) });

    return res.json({ ok: true, scores: allScores });
  } catch (e) {
    console.error('Arena judge error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST /events/:id/distribute → Calculate & distribute prizes (admin) ----
router.post('/events/:id/distribute', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  const { createdBy, message, signature } = req.body;

  if (!verifySig(message, signature, createdBy)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (!isAdmin(createdBy)) {
    return res.status(403).json({ error: 'Only admin can distribute prizes' });
  }

  const eventId = req.params.id;

  try {
    const event = await redis.hgetall(`arena:event:${eventId}`);
    if (!event || !event.id) return res.status(404).json({ error: 'Event not found' });
    if (event.status === 'completed') return res.status(400).json({ error: 'Prizes already distributed' });

    const participants = JSON.parse(event.participants || '[]');
    const scores = JSON.parse(event.scores || '{}');
    const votes = JSON.parse(event.votes || '{}');
    const facilitator = JSON.parse(event.facilitator || '{}');
    const entryFee = parseFloat(event.entryFee || '0');

    if (participants.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 participants' });
    }

    // Rank participants by total score
    const rankings = participants
      .map(p => {
        const key = `${p.network}:${p.agentId}`;
        const s = scores[key] || {};
        return { ...p, agentKey: key, avgScore: s.avgScore || 0, totalScore: s.totalScore || 0 };
      })
      .sort((a, b) => b.avgScore - a.avgScore || b.totalScore - a.totalScore);

    const winnerKey = rankings[0].agentKey;
    const winnerAddress = rankings[0].ownerAddress;

    // ---- Prize calculation ----
    // Loser penalty: 20% of entry fee → reward pot
    // Losers get 80% refund, Winner gets full entry back + 10% of reward pot
    // 90% of reward pot → winning voters (split equally)
    const loserCount = participants.length - 1;
    const penaltyPerLoser = entryFee * 0.2;
    const rewardPot = loserCount * penaltyPerLoser;
    const winnerBonus = rewardPot * 0.1;
    const voterPool = rewardPot * 0.9;
    const loserRefund = entryFee * 0.8;

    // Find winning voters (those who voted for the winner)
    const winningVoters = votes[winnerKey] || [];
    const perVoter = winningVoters.length > 0 ? voterPool / winningVoters.length : 0;

    // Build distribution plan
    const distributions = [];

    // Winner: entry fee back + bonus
    distributions.push({
      address: winnerAddress,
      amount: entryFee + winnerBonus,
      reason: 'winner',
      agent: rankings[0].name,
    });

    // Losers: 80% refund
    for (let i = 1; i < rankings.length; i++) {
      distributions.push({
        address: rankings[i].ownerAddress,
        amount: loserRefund,
        reason: 'loser_refund',
        agent: rankings[i].name,
      });
    }

    // Winning voters
    for (const voter of winningVoters) {
      distributions.push({
        address: voter,
        amount: perVoter,
        reason: 'voter_reward',
      });
    }

    // If no winning voters, winner bonus absorbs the voter pool
    if (winningVoters.length === 0 && voterPool > 0) {
      distributions[0].amount += voterPool;
      distributions[0].reason = 'winner_plus_unclaimed';
    }

    // ---- Execute USDC transfers via facilitator ----
    const txResults = [];
    for (const dist of distributions) {
      if (dist.amount <= 0) continue;
      const amountUnits = toUsdcUnits(dist.amount);
      try {
        const txHash = await facinetTransferUsdc(facilitator, dist.address, amountUnits);
        txResults.push({ ...dist, txHash, status: 'success' });
      } catch (e) {
        console.error(`Prize transfer failed for ${dist.address}:`, e.message);
        txResults.push({ ...dist, txHash: null, status: 'failed', error: e.message });
      }
    }

    // ---- Update ELO for all participants ----
    // Winner gains ELO against each loser; losers lose ELO
    for (let i = 1; i < rankings.length; i++) {
      const winnerEloKey = rankings[0].agentKey;
      const loserEloKey = rankings[i].agentKey;

      const currentWinner = (await redis.zscore('arena:elo', winnerEloKey)) || DEFAULT_ELO;
      const currentLoser = (await redis.zscore('arena:elo', loserEloKey)) || DEFAULT_ELO;

      const { newA, newB } = computeElo(Number(currentWinner), Number(currentLoser), 1);

      await redis.zadd('arena:elo', { score: newA, member: winnerEloKey });
      await redis.zadd('arena:elo', { score: newB, member: loserEloKey });
    }

    // Track stats
    for (const r of rankings) {
      await redis.hincrby('arena:stats', `${r.agentKey}:battles`, 1);
    }
    await redis.hincrby('arena:stats', `${rankings[0].agentKey}:wins`, 1);

    // Save results
    const results = {
      rankings: rankings.map((r, i) => ({
        rank: i + 1,
        agentKey: r.agentKey,
        name: r.name,
        ownerAddress: r.ownerAddress,
        avgScore: r.avgScore,
        totalScore: r.totalScore,
      })),
      rewardPot,
      winnerBonus,
      voterPool,
      perVoter,
      winningVoterCount: winningVoters.length,
      distributions: txResults,
    };

    await redis.hset(`arena:event:${eventId}`, {
      status: 'completed',
      results: JSON.stringify(results),
    });

    return res.json({ ok: true, results });
  } catch (e) {
    console.error('Arena distribute error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- GET /leaderboard → Global ELO leaderboard ----
router.get('/leaderboard', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });

  try {
    const entries = await redis.zrange('arena:elo', 0, -1, { rev: true, withScores: true });
    const leaderboard = [];

    for (const entry of entries) {
      const key = typeof entry === 'object' ? entry.value || entry.member : entry;
      const elo = typeof entry === 'object' ? entry.score : 0;
      const [network, agentId] = String(key).split(':');
      if (!network || !agentId) continue;

      const agentData = await redis.hgetall(`agent:${network}:${agentId}`);
      const battlesPlayed = parseInt((await redis.hget('arena:stats', `${network}:${agentId}:battles`)) || '0', 10);
      const wins = parseInt((await redis.hget('arena:stats', `${network}:${agentId}:wins`)) || '0', 10);

      leaderboard.push({
        rank: leaderboard.length + 1,
        network,
        agentId,
        name: agentData?.name || `Agent #${agentId}`,
        imageUrl: agentData?.imageUrl || '',
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

// ---- GET /admin-check → Check if address is admin ----
router.get('/admin-check', (req, res) => {
  const { address } = req.query;
  if (!address) return res.json({ isAdmin: false });
  return res.json({ isAdmin: isAdmin(address) });
});

export default router;
