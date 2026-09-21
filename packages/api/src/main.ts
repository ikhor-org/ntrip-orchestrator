import { getDefaultStore } from '@grokbot/core';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = getDefaultStore();
  await store.load();
  store.seedFixtureOrg();
  const server = createServer({ store, config });
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `grokbot-api M1 listening on :${config.port} (fixture_orgs=${config.allowFixtureOrgs})`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
