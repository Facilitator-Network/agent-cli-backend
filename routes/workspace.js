import { Router } from 'express';
import redis from '../lib/redis.js';

const router = Router();

const MAX_HISTORY = 50;

// ---- POST /call → Proxy a call to the hired agent ----
router.post('/call', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Not configured' });

  const { hireId, message, files } = req.body;

  if (!hireId || !message) {
    return res.status(400).json({ error: 'hireId and message are required' });
  }

  try {
    // 1. Validate hire
    const hire = await redis.hgetall(`hire:${hireId}`);
    if (!hire || !hire.hireId) {
      return res.status(404).json({ error: 'Hire not found' });
    }

    if (hire.status !== 'active') {
      return res.status(403).json({ error: `Hire is ${hire.status}` });
    }

    if (new Date(hire.expiresAt) < new Date()) {
      await redis.hset(`hire:${hireId}`, { status: 'expired' });
      return res.status(403).json({ error: 'Hire has expired' });
    }

    const callsUsed = Number(hire.callsUsed) || 0;
    const callsTotal = Number(hire.callsTotal) || 1;
    if (callsUsed >= callsTotal) {
      await redis.hset(`hire:${hireId}`, { status: 'exhausted' });
      return res.status(403).json({ error: 'No calls remaining' });
    }

    // 2. Look up agent endpoint
    const agent = await redis.hgetall(`agent:${hire.network}:${hire.agentId}`);
    if (!agent || !agent.name) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const endpoint = agent.a2aEndpoint || agent.mcpEndpoint || agent.url;
    if (!endpoint) {
      return res.status(400).json({ error: 'Agent has no callable endpoint' });
    }

    // 3. Build request based on endpoint type
    let agentResponse;
    const isA2A = !!agent.a2aEndpoint;
    const isMCP = !isA2A && !!agent.mcpEndpoint;

    if (isA2A) {
      // A2A protocol: JSON-RPC message/send
      const a2aPayload = {
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: message }],
          },
        },
        id: Date.now(),
      };

      // Add files as inline data parts
      if (files && files.length > 0) {
        for (const f of files) {
          a2aPayload.params.message.parts.push({
            type: 'data',
            mimeType: f.mimeType || 'application/octet-stream',
            data: f.data, // base64
            name: f.name,
          });
        }
      }

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a2aPayload),
        signal: AbortSignal.timeout(30000),
      });
      agentResponse = await resp.json();

    } else if (isMCP) {
      // MCP protocol: JSON-RPC tools/call
      const mcpPayload = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'process',
          arguments: {
            message,
            ...(files && files.length > 0 ? { files } : {}),
          },
        },
        id: Date.now(),
      };

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mcpPayload),
        signal: AbortSignal.timeout(30000),
      });
      agentResponse = await resp.json();

    } else {
      // Generic HTTP endpoint: POST with JSON body
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, files }),
        signal: AbortSignal.timeout(30000),
      });
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('json')) {
        agentResponse = await resp.json();
      } else {
        agentResponse = { text: await resp.text() };
      }
    }

    // 4. Extract response text
    let responseText = '';
    if (agentResponse.result?.message?.parts) {
      // A2A response
      responseText = agentResponse.result.message.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
    } else if (agentResponse.result?.content) {
      // MCP response
      const textParts = Array.isArray(agentResponse.result.content)
        ? agentResponse.result.content
        : [agentResponse.result.content];
      responseText = textParts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
    } else if (agentResponse.text) {
      responseText = agentResponse.text;
    } else if (typeof agentResponse === 'string') {
      responseText = agentResponse;
    } else {
      responseText = JSON.stringify(agentResponse, null, 2);
    }

    // 5. Increment usage
    await redis.hincrby(`hire:${hireId}`, 'callsUsed', 1);

    // 6. Store in history
    const historyKey = `workspace:history:${hireId}`;
    const entry = {
      userMessage: message,
      agentResponse: responseText,
      timestamp: new Date().toISOString(),
      hasFiles: !!(files && files.length > 0),
    };
    await redis.lpush(historyKey, JSON.stringify(entry));
    await redis.ltrim(historyKey, 0, MAX_HISTORY - 1);
    // 24h TTL on history
    await redis.expire(historyKey, 86400);

    return res.json({
      response: responseText,
      callsUsed: callsUsed + 1,
      callsTotal,
      raw: agentResponse,
    });
  } catch (e) {
    console.error('Workspace call error:', e.message);
    // If it's a timeout or network error, still count it
    return res.status(502).json({
      error: `Agent call failed: ${e.message}`,
      response: null,
    });
  }
});

// ---- GET /history/:hireId → Get message history ----
router.get('/history/:hireId', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Not configured' });

  try {
    const hire = await redis.hgetall(`hire:${req.params.hireId}`);
    if (!hire || !hire.hireId) {
      return res.status(404).json({ error: 'Hire not found' });
    }

    const raw = await redis.lrange(`workspace:history:${req.params.hireId}`, 0, MAX_HISTORY - 1);
    const history = raw.map((entry) => {
      try { return JSON.parse(entry); } catch { return entry; }
    });

    return res.json({ history: history.reverse() }); // oldest first
  } catch (e) {
    console.error('History error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ---- POST /clear/:hireId → Clear conversation history ----
router.post('/clear/:hireId', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Not configured' });

  try {
    await redis.del(`workspace:history:${req.params.hireId}`);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
