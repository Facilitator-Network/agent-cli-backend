# 8004agent Backend API

Backend for the **8004agent** CLI. Holds all secrets (Privy, Gemini, Vercel, relayer) so the CLI can be published to npm without any env vars for end users.

## Run locally

```bash
cd backend
cp .env.example .env
# Edit .env and set: PRIVY_APP_ID, PRIVY_APP_SECRET, GEMINI_API_KEY, VERCEL_TOKEN, RELAYER_PRIVATE_KEY, TREASURY_ADDRESS
npm install
npm run dev
```

Server runs at **http://localhost:4000** by default.

## Use CLI against local backend

```bash
export 8004AGENT_API_URL=http://localhost:4000
cd ../cli && node bin/cli.js create
```

## Deploy for production

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for step-by-step deployment (Railway, Render, Fly.io, VPS), required env vars, relayer funding, and how to point the published CLI at your backend so public users can run `npx 8004agent` with no setup.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness |
| POST | `/api/privy/create-wallet` | Create Privy wallet for agent |
| POST | `/api/ai/generate-code` | Generate agent code (Gemini) |
| POST | `/api/payment/submit` | Submit gasless USDC payment (relayer) |
| GET | `/api/payment/config` | Public config (treasury, networks) |
| POST | `/api/deploy` | Deploy agent to Vercel |
| POST | `/api/register` | Register agent on-chain (relayer) |
| POST | `/api/agent-wallet/deploy` | Deploy AgentWallet (relayer) |
| POST | `/api/identity` | setAgentWallet (relayer) |

Rate limit: 120 requests per minute per IP.
