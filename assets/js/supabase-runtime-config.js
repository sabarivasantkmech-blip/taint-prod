const SUPABASE_CONFIG = (() => {
  const cfg = window.TAINT_SUPABASE_CONFIG || {};
  const env = String(cfg.environment || 'dev').toLowerCase();
  const hasEnvCfg = !!(cfg.environments && Object.prototype.hasOwnProperty.call(cfg.environments, env));
  const envCfg = hasEnvCfg ? (cfg.environments[env] || {}) : {};
  const trimUrl = value => String(value || '').trim().replace(/\/+$/, '');
  return {
    environment: env,
    label      : String(envCfg.label || env).trim() || env,
    isProduction: env === 'prod',
    url        : trimUrl(hasEnvCfg ? envCfg.url : (cfg.url || 'YOUR_PROJECT_URL')),
    anonKey    : String(hasEnvCfg ? envCfg.anonKey : (cfg.anonKey || 'YOUR_ANON_PUBLIC_KEY')).trim(),
    siteUrl    : String(hasEnvCfg ? envCfg.siteUrl : (cfg.auth?.siteUrl || cfg.siteUrl || '')).trim()
  };
})();
window.TAINT_RUNTIME_CONFIG = SUPABASE_CONFIG;
