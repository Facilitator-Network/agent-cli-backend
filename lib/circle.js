import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY || '';
const CIRCLE_ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET || '';
const CIRCLE_WALLET_SET_ID = process.env.CIRCLE_WALLET_SET_ID || '';

let circleClient = null;

if (CIRCLE_API_KEY && CIRCLE_ENTITY_SECRET) {
  circleClient = initiateDeveloperControlledWalletsClient({
    apiKey: CIRCLE_API_KEY,
    entitySecret: CIRCLE_ENTITY_SECRET,
  });
}

export { circleClient, CIRCLE_WALLET_SET_ID };
