export interface ApiConfig {
  port: number;
  allowFixtureOrgs: boolean;
  nodeEnv: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const allow =
    env.ALLOW_FIXTURE_ORGS === 'true' && nodeEnv !== 'production';
  return {
    port: Number(env.API_PORT ?? 8080),
    allowFixtureOrgs: allow,
    nodeEnv,
  };
}
