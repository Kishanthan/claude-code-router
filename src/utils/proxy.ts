import { ProxyAgent, setGlobalDispatcher } from "undici";

const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"];

let proxyConfigured = false;

const getEnvProxy = () => {
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key]) return process.env[key]!;
  }
  return undefined;
};

const shouldBypassProxy = () => {
  const noProxy = NO_PROXY_KEYS.map((key) => process.env[key]).find(Boolean);
  // If NO_PROXY is explicitly set to "*", respect it and skip proxying.
  return noProxy?.trim() === "*";
};

export const applyProxyFromEnv = (config?: Record<string, any>) => {
  if (proxyConfigured) return;

  const proxyUrl =
    getEnvProxy() ||
    config?.PROXY ||
    config?.proxy;

  if (!proxyUrl || shouldBypassProxy()) {
    return;
  }

  try {
    const proxyAgent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(proxyAgent);
    proxyConfigured = true;
    console.log("Proxy detected; routing HTTP(S) requests through configured proxy.");
  } catch (error: any) {
    console.warn("Failed to apply proxy settings:", error?.message || error);
  }
};
