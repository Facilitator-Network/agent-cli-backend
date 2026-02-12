import { ethers } from 'ethers';

// Server-side: read from env only (no defaults for secrets)
export const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '';
export const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY || '';

// Relayer address derived from private key (for CCTP: non-Fuji payments go to relayer)
export const RELAYER_ADDRESS = RELAYER_PRIVATE_KEY
  ? new ethers.Wallet(RELAYER_PRIVATE_KEY).address
  : '';

// ---- CCTP V2 (same on all 3 testnets) ----
export const CCTP = {
  tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  attestationApi: 'https://iris-api-sandbox.circle.com/v1/attestations',
  fujiDomain: 1,
};

// Per-chain CCTP domain and native USDC (testnet)
export const CCTP_DOMAINS = {
  sepolia: 0,
  fuji: 1,
  baseSepolia: 6,
};

export const USDC_ADDRESSES = {
  sepolia: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  fuji: '0x5425890298aed601595a70AB815c96711a31Bc65',
  baseSepolia: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

// Facinet SDK network mapping (for facilitator-based gasless payments)
export const FACINET_NETWORK_MAP = {
  sepolia: 'ethereum-sepolia',
  baseSepolia: 'base-sepolia',
  fuji: 'avalanche-fuji',
};

// Facinet API URL
export const FACINET_API_URL = 'https://facinet.vercel.app';

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
