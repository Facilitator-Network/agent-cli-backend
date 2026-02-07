// Server-side: read from env only (no defaults for secrets)
export const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '';
export const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY || '';

export const CONTRACTS = {
  sepolia: {
    name: 'Ethereum Sepolia',
    rpc: process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
    chainId: 11155111,
    identityRegistry: '0x4d7cCF8B5852e18156bCCB53782e5Aa639Ce1068',
    agentWalletFactory: '0xd456039F1A4a8796a9c0F10ca5B46Bb81E610d0d',
  },
  baseSepolia: {
    name: 'Base Sepolia',
    rpc: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    chainId: 84532,
    identityRegistry: '0x2F46046733B3369d5cFFc5795859c7DbEfdEeB6C',
    agentWalletFactory: '0xA2EdB5FDd37142975B4E011F48906bd993589664',
  },
  amoy: {
    name: 'Polygon Amoy',
    rpc: process.env.POLYGON_AMOY_RPC_URL || 'https://rpc-amoy.polygon.technology',
    chainId: 80002,
    identityRegistry: '0xb709E56DB1fd6Ee0d6192f69fD9D3Fc33A7EEFb5',
    agentWalletFactory: '0x388166fb3B38aFa179B76444d742A329b78B4FF4',
  },
  fuji: {
    name: 'Avalanche Fuji',
    rpc: process.env.AVALANCHE_FUJI_RPC_URL || 'https://api.avax-test.network/ext/bc/C/rpc',
    chainId: 43113,
    identityRegistry: '0x5855510F3865896923f4c0d4B37f418DBBDD56e0',
    agentWalletFactory: '0x3f7039Be8013a30F731841b2A045464D1b25F143',
  },
};
