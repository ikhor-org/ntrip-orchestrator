import { listenProxy } from './server.js';

const port = Number(process.env.PROXY_PORT ?? 2101);
const server = listenProxy({ port });
server.on('listening', () => {
  // eslint-disable-next-line no-console
  console.log(`grokbot-proxy M0 listening on :${port} (auth stub; no upstream)`);
});
