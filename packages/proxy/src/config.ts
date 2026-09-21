export interface ProxyRuntimeConfig {
  port: number;
  vaultKekRaw?: string;
  storePath?: string;
  /** Fallback upstream when org has no vaulted endpoint (dev). */
  ntripUpstreamHost?: string;
  ntripUpstreamPort: number;
  ntripUpstreamMountpoint?: string;
  ntripUpstreamUser?: string;
  ntripUpstreamPass?: string;
  ntripUpstreamTls: boolean;
}

export function loadProxyConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProxyRuntimeConfig {
  const cfg: ProxyRuntimeConfig = {
    port: Number(env.PROXY_PORT ?? 2101),
    ntripUpstreamPort: Number(env.NTRIP_UPSTREAM_PORT ?? 2101),
    ntripUpstreamTls: env.NTRIP_UPSTREAM_TLS === 'true',
  };
  const kek = env.VAULT_KEK ?? env.VAULT_MASTER_KEY;
  if (kek) cfg.vaultKekRaw = kek;
  if (env.GROKBOT_STORE_PATH) cfg.storePath = env.GROKBOT_STORE_PATH;
  if (env.NTRIP_UPSTREAM_HOST) cfg.ntripUpstreamHost = env.NTRIP_UPSTREAM_HOST;
  if (env.NTRIP_UPSTREAM_MOUNTPOINT) {
    cfg.ntripUpstreamMountpoint = env.NTRIP_UPSTREAM_MOUNTPOINT;
  }
  if (env.NTRIP_UPSTREAM_USER) cfg.ntripUpstreamUser = env.NTRIP_UPSTREAM_USER;
  if (env.NTRIP_UPSTREAM_PASS) cfg.ntripUpstreamPass = env.NTRIP_UPSTREAM_PASS;
  return cfg;
}
