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

router.post('/generate-code', async (req, res) => {
  const { name, personality, capability, imageUrl, details } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name required' });
  }

  if (!model) {
    return res.json({ code: getTemplateCode(name, personality || '', capability || '', imageUrl) });
  }

  try {
    const prompt = `You are an AI Agent Developer. Create a single-file Node.js server (using express) for an AI agent named "${name}".
        
Personality: ${personality || ''}
Primary Capability: ${capability || ''}
Additional Details: ${details || 'None'}
Image URL: ${imageUrl || 'None'}
        
Requirements:
1. Responds to GET / with a welcome message reflecting its personality.
2. Responds to POST /chat with a JSON body { "message": "user input" } and returns { "response": "..." }.
3. The chat logic should explicitly roleplay the personality and attempt to fulfill the capability.
4. Include the provided Image URL in the welcome message HTML or JSON response if applicable.
5. Return ONLY the code, no markdown formatting (no \`\`\` wrappers).
6. Ensure the code is production-ready (error handling, port env var).
`;

    const result = await model.generateContent(prompt);
    let code = result.response.text();
    code = code.replace(/```javascript/g, '').replace(/```node/g, '').replace(/```js/g, '').replace(/```/g, '');
    return res.json({ code });
  } catch (e) {
    console.error('Gemini generation failed:', e.message);
    return res.json({ code: getTemplateCode(name, personality || '', capability || '', imageUrl) });
  }
});

export default router;
