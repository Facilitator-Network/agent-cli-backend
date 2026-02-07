# Deploy 8004agent Backend for Public CLI

When users run `npx 8004agent` or `npm i -g 8004agent`, the CLI calls your backend API. Deploy this backend once and point the CLI at it so **no user needs to set API keys or run a server**.

---

## 1. Required environment variables

Set these on your hosting platform (never commit real values to git).

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVY_APP_ID` | Yes | Privy dashboard app ID |
| `PRIVY_APP_SECRET` | Yes | Privy app secret |
| `GEMINI_API_KEY` | Yes | Google AI Studio key for agent code generation |
| `VERCEL_TOKEN` | Yes | Vercel token for deploying agent apps |
| `VERCEL_TEAM_ID` | If using Vercel team | Team ID (optional for personal accounts) |
| `RELAYER_PRIVATE_KEY` | Yes | Wallet that pays gas for register + gasless payments |
| `TREASURY_ADDRESS` | Yes | Address that receives USDC (Facinet) |
| `PORT` | No | Server port (default `4000`; host often sets this) |

Optional RPC overrides (defaults work for testnets):

- `SEPOLIA_RPC_URL`
- `BASE_SEPOLIA_RPC_URL`
- `POLYGON_AMOY_RPC_URL`
- `AVALANCHE_FUJI_RPC_URL`

---

## 2. Fund the relayer

The wallet for `RELAYER_PRIVATE_KEY` must have:

- **Native gas** on each network you support (Sepolia, Base Sepolia, Amoy, Fuji) so it can send `register()` and `transferFrom()` (and AgentWallet deploys).
- No USDC needed in the relayer; users pay USDC to `TREASURY_ADDRESS` via gasless signing.

---

## 3. Deploy the backend

### Option A: Railway

1. Go to [railway.app](https://railway.app), sign in, **New Project** → **Deploy from GitHub repo** (or upload `backend/`).
2. Set **Root Directory** to `backend` (if repo is the whole project).
3. In the service → **Variables**, add every env var from the table above.
4. **Deploy**. Railway gives a URL like `https://your-app.up.railway.app`.
5. In **Settings** → **Networking** → **Generate Domain** if you don’t have one yet.

Your API base URL = `https://<your-railway-domain>` (no trailing slash).

### Option B: Render

1. Go to [render.com](https://render.com) → **New** → **Web Service**.
2. Connect the repo; set **Root Directory** to `backend`.
3. **Build**: `npm install`
4. **Start**: `npm start` (runs `node server.js`).
5. **Environment** → add all env vars.
6. Deploy. URL will be like `https://your-service.onrender.com`.

Your API base URL = `https://<your-render-service>.onrender.com`.

### Option C: Fly.io

```bash
cd backend
fly launch
# Set build/run when prompted, or add a Dockerfile
fly secrets set PRIVY_APP_ID=... PRIVY_APP_SECRET=... GEMINI_API_KEY=... \
  VERCEL_TOKEN=... RELAYER_PRIVATE_KEY=... TREASURY_ADDRESS=...
fly deploy
```

Your API base URL = `https://<your-app>.fly.dev`.

### Option D: Your own server (VPS)

```bash
cd backend
npm install --production
# Use a process manager (e.g. systemd or pm2)
PORT=4000 node server.js
```

Put the app behind HTTPS (e.g. Nginx + Let’s Encrypt). Your API base URL = `https://your-domain.com`.

---

## 4. Point the CLI at your backend

Two options:

**A) Default URL in the CLI (best for public publish)**  
In `cli/src/lib/api.js`, set:

```js
const DEFAULT_API_URL = 'https://your-actual-backend-url.com';
```

Then republish the CLI. Everyone using `npx 8004agent` or the published package will use this backend with no extra config.

**B) Ask users to set the URL**  
If you don’t want to hardcode:

- Publish the CLI with a placeholder or no default.
- In docs, tell users:  
  `export 8004AGENT_API_URL=https://your-backend-url.com`  
  (or set `8004AGENT_API_URL` in their environment).

---

## 5. After deployment

1. **Health check**  
   `curl https://your-api-url/health`  
   Should return: `{"ok":true,"service":"8004agent-backend"}`.

2. **Test create flow**  
   - Set `8004AGENT_API_URL=https://your-api-url` (no trailing slash).
   - Run `8004agent init` then `8004agent create` and complete the flow (payment method, etc.).

3. **Monitor**  
   - Use your host’s logs and metrics.
   - Optionally add error tracking (e.g. Sentry) in `backend/server.js`.

4. **Secrets**  
   - Rotate `RELAYER_PRIVATE_KEY` / `PRIVY_APP_SECRET` / `VERCEL_TOKEN` via your host’s env UI and redeploy; no code change needed.

---

## 6. Summary

| Step | Action |
|------|--------|
| 1 | Create backend project (e.g. Railway/Render/Fly) from `backend/` |
| 2 | Set all required env vars and fund the relayer |
| 3 | Deploy and note the public URL (e.g. `https://api.8004agent.network`) |
| 4 | Set `DEFAULT_API_URL` in `cli/src/lib/api.js` to that URL and publish the CLI |
| 5 | Users run `npx 8004agent` with no env or backend setup |

Once this is done, the public CLI works for everyone without any local backend or API keys.
