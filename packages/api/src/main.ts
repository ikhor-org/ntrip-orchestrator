import { loadConfig } from './config.js';
import { createServer } from './server.js';

const config = loadConfig();
const server = createServer();
server.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `grokbot-api M0 listening on :${config.port} (fixture_orgs=${config.allowFixtureOrgs})`,
  );
});
