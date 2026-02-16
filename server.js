import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import privyRoutes from './routes/privy.js';
import aiRoutes from './routes/ai.js';
import paymentRoutes from './routes/payment.js';
import deployRoutes from './routes/deploy.js';
import registerRoutes from './routes/register.js';
import setAgentWalletRoutes from './routes/setAgentWallet.js';
import metadataRoutes from './routes/metadata.js';
import sessionRoutes from './routes/session.js';
import agentsRoutes from './routes/agents.js';
import nftRoutes from './routes/nft.js';
import circleRoutes from './routes/circle.js';
import bridgeRoutes from './routes/bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 4000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use((_req, res, next) => {
  res.set('X-8004agent-API', '1');
  next();
});

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests, try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.use('/api/privy', privyRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/deploy', deployRoutes);
app.use('/api/register', registerRoutes);
app.use('/api/identity', setAgentWalletRoutes);
app.use('/api/metadata', metadataRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/nft', nftRoutes);
app.use('/api/circle', circleRoutes);
app.use('/api/bridge', bridgeRoutes);

// Serve browser signing page
app.get('/sign/:sessionId', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sign.html'));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: '8004agent-backend' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`8004agent backend listening on port ${PORT}`);
});
