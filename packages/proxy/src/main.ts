import { getDefaultStore } from '@ntrip-orchestrator/core';
import { loadProxyConfig } from './config.js';
import { createProxyServer } from './server.js';

async function main(): Promise<void> {
  const config = loadProxyConfig();
  const store = getDefaultStore();
  await store.load();
  store.seedFixtureOrg();
  const server = createProxyServer({ config, store });
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `ntrip-orchestrator-proxy M1 listening on :${config.port} (generic NTRIP relay)`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
