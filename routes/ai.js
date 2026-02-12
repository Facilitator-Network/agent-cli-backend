import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

const router = Router();
const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;
const model = genAI ? genAI.getGenerativeModel({ model: 'gemini-pro' }) : null;

function getTemplateCode(name, personality, capability, imageUrl) {
  return `
const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const IMAGE_URL = "${imageUrl || ''}";

app.get('/', (req, res) => {
    res.send(\`<h1>Hello, I am ${name}</h1><p>${personality}</p><img src="\${IMAGE_URL}" style="max-width:200px;" />\`);
});

app.post('/chat', (req, res) => {
    const { message } = req.body;
    res.json({
        response: \`I am ${name}. You said: \${message}. My capability is: ${capability}.\`
    });
});

app.listen(PORT, () => console.log(\`Agent ${name} listening on port \${PORT}\`));
`;
}

function buildPrompt(body) {
  const {
    name, personality, capability, imageUrl, details,
    description, skills, domains, mcpEndpoint, a2aEndpoint,
    x402Payment, trustModels, version, author, license,
  } = body;

  const skillsList = Array.isArray(skills) && skills.length > 0
    ? skills.join(', ')
    : capability || 'general assistance';

  const domainsList = Array.isArray(domains) && domains.length > 0
    ? domains.join(', ')
    : 'general';

  const trustList = Array.isArray(trustModels) && trustModels.length > 0
    ? trustModels.join(', ')
    : 'none';

  return `You are an expert AI Agent Developer. Create a single-file Node.js server (using express) for an AI agent.

=== AGENT IDENTITY ===
Name: ${name}
Description: ${description || personality || 'An AI agent'}
Personality / System Prompt: ${personality || 'Helpful and professional'}
Version: ${version || '1.0.0'}
Author: ${author || 'Anonymous'}
License: ${license || 'MIT'}
Image URL: ${imageUrl || 'None'}

=== CAPABILITIES ===
Skills: ${skillsList}
Application Domains: ${domainsList}
Additional Details: ${details || 'None'}

=== ENDPOINTS & PROTOCOLS ===
MCP Endpoint: ${mcpEndpoint || 'Not specified'}
A2A Endpoint: ${a2aEndpoint || 'Not specified'}
X402 Payment Support: ${x402Payment !== false ? 'Yes' : 'No'}
Trust Models: ${trustList}

=== REQUIREMENTS ===
1. GET / — Returns a rich HTML welcome page with the agent's name, description, skills, domains, image (if provided), and version info. Make it visually clean with inline CSS.
2. POST /chat — Accepts { "message": "user input" } and returns { "response": "..." }. The response logic should reflect the agent's personality and actively use its skills/domain knowledge.
3. GET /health — Returns { "status": "ok", "name": "${name}", "version": "${version || '1.0.0'}" }.
4. GET /.well-known/agent.json — Returns the agent's metadata as JSON (name, description, skills, domains, version, author, license, endpoints).
${mcpEndpoint ? `5. GET /mcp — Scaffold an MCP-compatible endpoint that lists the agent's capabilities in MCP format.` : ''}
${a2aEndpoint ? `6. POST /a2a — Scaffold an A2A (agent-to-agent) communication endpoint that accepts { "from": "agent-id", "message": "..." } and returns a response.` : ''}
${x402Payment !== false ? `7. Add x402 payment awareness: include an X-Payment header check middleware that logs payment info when present.` : ''}

=== CODE RULES ===
- Return ONLY the JavaScript code, no markdown formatting (no \`\`\` wrappers).
- Use require() syntax (CommonJS).
- Production-ready: error handling, PORT from env, proper JSON responses.
- Add meaningful logic for each skill — don't just echo back the input. Simulate domain expertise.
- Keep it as a single file, no external dependencies beyond express.
`;
}

router.post('/generate-code', async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name required' });
  }

  if (!model) {
    return res.json({ code: getTemplateCode(name, req.body.personality || '', req.body.capability || '', req.body.imageUrl) });
  }

  try {
    const prompt = buildPrompt(req.body);
    const result = await model.generateContent(prompt);
    let code = result.response.text();
    code = code.replace(/```javascript/g, '').replace(/```node/g, '').replace(/```js/g, '').replace(/```/g, '');
    return res.json({ code });
  } catch (e) {
    console.error('Gemini generation failed:', e.message);
    return res.json({ code: getTemplateCode(name, req.body.personality || '', req.body.capability || '', req.body.imageUrl) });
  }
});

export default router;
