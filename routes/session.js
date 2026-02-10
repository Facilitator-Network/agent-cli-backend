import { Router } from 'express';
import crypto from 'crypto';

const router = Router();

// ---- In-memory session store ----
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function cleanup() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// ---- POST / → Create session ----
router.post('/', (_req, res) => {
  cleanup();
  const id = crypto.randomUUID();
  const session = {
    id,
    createdAt: Date.now(),
    walletAddress: null,
    currentRequest: null,
    currentSignature: null,
    completed: false,
  };
  sessions.set(id, session);
  const signingUrl = `${getBaseUrl(_req)}/sign/${id}`;
  res.json({ sessionId: id, signingUrl });
});

// ---- GET /:id → Get session state ----
router.get('/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({
    walletAddress: session.walletAddress,
    currentRequest: session.currentRequest,
    currentSignature: session.currentSignature,
    completed: session.completed,
  });
});

// ---- POST /:id/wallet → Browser sends connected wallet address ----
router.post('/:id/wallet', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });
  session.walletAddress = walletAddress;
  res.json({ ok: true });
});

// ---- POST /:id/request → CLI pushes a sign request ----
router.post('/:id/request', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  const { id, label, eip712 } = req.body;
  if (!id || !eip712) return res.status(400).json({ error: 'id and eip712 required' });
  session.currentRequest = { id, label: label || 'Sign Request', eip712 };
  session.currentSignature = null; // clear previous
  res.json({ ok: true });
});

// ---- POST /:id/signature → Browser sends back signature ----
router.post('/:id/signature', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  const { requestId, signature } = req.body;
  if (!requestId || !signature) return res.status(400).json({ error: 'requestId and signature required' });
  session.currentSignature = { requestId, signature };
  session.currentRequest = null; // clear request after signing
  res.json({ ok: true });
});

// ---- POST /:id/complete → CLI marks session done ----
router.post('/:id/complete', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  session.completed = true;
  session.currentRequest = null;
  res.json({ ok: true });
});

export default router;
