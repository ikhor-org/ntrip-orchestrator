export interface ApiConfig {
  port: number;
  allowFixtureOrgs: boolean;
  nodeEnv: string;
  vaultKekRaw?: string;
  storePath?: string;
  /** Platform ops key for pilot intake / screening / activate / suspend. */
  opsApiKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const allow =
    env.ALLOW_FIXTURE_ORGS === 'true' && nodeEnv !== 'production';
  const cfg: ApiConfig = {
    port: Number(env.API_PORT ?? 8080),
    allowFixtureOrgs: allow,
    nodeEnv,
  };
  const kek = env.VAULT_KEK ?? env.VAULT_MASTER_KEY;
  if (kek) cfg.vaultKekRaw = kek;
  if (env.GROKBOT_STORE_PATH) cfg.storePath = env.GROKBOT_STORE_PATH;
  if (env.OPS_API_KEY && env.OPS_API_KEY.trim()) {
    cfg.opsApiKey = env.OPS_API_KEY.trim();
  }
  return cfg;
}
