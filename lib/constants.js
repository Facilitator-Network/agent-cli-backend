// Server-side: read from env only (no defaults for secrets)
export const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '';
export const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY || '';

// ---- Per-chain contracts (official ERC-8004) ----
export const CONTRACTS = {
  sepolia: {
    name: 'Ethereum Sepolia',
    rpc: process.env.SEPOLIA_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/lnZTAJ33w-8tB8DrJrRpl',
    chainId: 11155111,
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  },
  baseSepolia: {
    name: 'Base Sepolia',
    rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia.g.alchemy.com/v2/lnZTAJ33w-8tB8DrJrRpl',
    chainId: 84532,
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  },
  fuji: {
    name: 'Avalanche Fuji',
    rpc: process.env.AVALANCHE_FUJI_RPC_URL || 'https://avax-fuji.g.alchemy.com/v2/lnZTAJ33w-8tB8DrJrRpl',
    chainId: 43113,
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  },
};
