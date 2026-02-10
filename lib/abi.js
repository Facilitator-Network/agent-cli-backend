export const IdentityRegistryABI = [
  'function register(string agentURI) external returns (uint256 agentId)',
  'function register(string agentURI, tuple(string metadataKey, bytes metadataValue)[] metadata) external returns (uint256 agentId)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature) external',
  'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue) external',
  'function setAgentURI(uint256 agentId, string newURI) external',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function transferFrom(address from, address to, uint256 tokenId) external',
  'function eip712Domain() external view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
];

const USDC_ERC3009_ABI = [
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external',
];
export { USDC_ERC3009_ABI };
