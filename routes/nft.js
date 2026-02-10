import { Router } from 'express';
import { ethers } from 'ethers';
import { CONTRACTS } from '../lib/constants.js';

const router = Router();

const METADATA_KEYS = ['name', 'image', 'description', 'version', 'author', 'license', 'mcpEndpoint', 'a2aEndpoint', 'skills', 'domains', 'status', 'hirePrice', 'url'];

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

function findNetworkByChainId(chainId) {
  const id = Number(chainId);
  for (const [key, cfg] of Object.entries(CONTRACTS)) {
    if (cfg.chainId === id) return { key, cfg };
  }
  return null;
}

// GET /:chainId/:agentId — ERC-721 metadata JSON
router.get('/:chainId/:agentId', async (req, res) => {
  const network = findNetworkByChainId(req.params.chainId);
  if (!network) {
    return res.status(404).json({ error: 'Unsupported chain ID' });
  }

  const agentId = req.params.agentId;
  const { cfg } = network;

  try {
    const provider = new ethers.JsonRpcProvider(cfg.rpc);
    const registry = new ethers.Contract(cfg.identityRegistry, abi, provider);

    // Fetch on-chain data in parallel
    const [tokenURI, owner, ...metaResults] = await Promise.all([
      registry.tokenURI(agentId).catch(() => ''),
      registry.ownerOf(agentId).catch(() => ''),
      ...METADATA_KEYS.map(key =>
        registry.getMetadata(agentId, key)
          .then(bytes => ({ key, value: ethers.toUtf8String(bytes) }))
          .catch(() => ({ key, value: '' }))
      ),
    ]);

    const meta = {};
    for (const { key, value } of metaResults) {
      if (value) meta[key] = value;
    }

    // Build ERC-721 metadata JSON
    const metadata = {
      name: meta.name || `Agent #${agentId}`,
      description: meta.description || `ERC-8004 Agent #${agentId}`,
      image: meta.image || '',
      external_url: meta.url || tokenURI || '',
      attributes: [],
    };

    // Add attributes
    if (meta.version) metadata.attributes.push({ trait_type: 'Version', value: meta.version });
    if (meta.author) metadata.attributes.push({ trait_type: 'Author', value: meta.author });
    if (meta.license) metadata.attributes.push({ trait_type: 'License', value: meta.license });
    if (meta.status) metadata.attributes.push({ trait_type: 'Status', value: meta.status });
    if (meta.hirePrice) metadata.attributes.push({ trait_type: 'Hire Price (USDC)', value: meta.hirePrice });
    if (owner) metadata.attributes.push({ trait_type: 'Owner', value: owner });
    if (meta.mcpEndpoint) metadata.attributes.push({ trait_type: 'MCP Endpoint', value: meta.mcpEndpoint });
    if (meta.a2aEndpoint) metadata.attributes.push({ trait_type: 'A2A Endpoint', value: meta.a2aEndpoint });

    if (meta.skills) {
      try {
        const skills = JSON.parse(meta.skills);
        if (Array.isArray(skills)) {
          for (const s of skills) {
            metadata.attributes.push({ trait_type: 'Skill', value: s });
          }
        }
      } catch (_) {}
    }

    if (meta.domains) {
      try {
        const domains = JSON.parse(meta.domains);
        if (Array.isArray(domains)) {
          for (const d of domains) {
            metadata.attributes.push({ trait_type: 'Domain', value: d });
          }
        }
      } catch (_) {}
    }

    // Cache for 5 minutes, allow stale for 1 hour
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.json(metadata);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
