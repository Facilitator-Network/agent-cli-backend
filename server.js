import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import privyRoutes from './routes/privy.js';
import aiRoutes from './routes/ai.js';
import paymentRoutes from './routes/payment.js';
import deployRoutes from './routes/deploy.js';
import registerRoutes from './routes/register.js';
import agentWalletRoutes from './routes/agentWallet.js';
import setAgentWalletRoutes from './routes/setAgentWallet.js';

const app = express();
const PORT = process.env.PORT || 4000;

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
app.use('/api/agent-wallet', agentWalletRoutes);
app.use('/api/identity', setAgentWalletRoutes);

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
