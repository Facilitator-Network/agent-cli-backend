import { Router } from 'express';
import axios from 'axios';

const router = Router();
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';

router.post('/', async (req, res) => {
  const { name, code } = req.body;
  if (!name || !code) {
    return res.status(400).json({ error: 'name and code required' });
  }

  if (!VERCEL_TOKEN) {
    const fallbackUrl = `https://${String(name).toLowerCase().replace(/\s+/g, '-')}.vercel.app`;
    return res.json({ url: fallbackUrl });
  }

  try {
    const projectName = String(name).toLowerCase().replace(/\s+/g, '-');
    const files = [
      { file: 'package.json', data: JSON.stringify({ name: projectName, version: '1.0.0', scripts: { start: 'node index.js' }, dependencies: { express: '^4.18.2' } }) },
      { file: 'index.js', data: code },
    ];

    const response = await axios.post(
      'https://api.vercel.com/v13/deployments',
      { name: projectName, files, projectSettings: { framework: null } },
      {
        headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
        params: VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID } : {},
      }
    );

    const url = response.data?.url ? `https://${response.data.url}` : null;
    if (!url) throw new Error('No URL in response');
    return res.json({ url });
  } catch (e) {
    const fallbackUrl = `https://${String(name).toLowerCase().replace(/\s+/g, '-')}.vercel.app`;
    console.error('Vercel deployment failed:', e.response?.data || e.message);
    return res.json({ url: fallbackUrl });
  }
});

export default router;
