import type { FastifyRequest } from "fastify";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEV_PROXY_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://[::1]:5173",
]);

export function isHttpOriginAllowed(
  request: FastifyRequest,
  publicOrigin: string | undefined,
): boolean {
  if (!MUTATING_METHODS.has(request.method)) {
    return true;
  }
  return isRequestOriginAllowed(request, publicOrigin);
}

export function isRequestOriginAllowed(
  request: FastifyRequest,
  publicOrigin: string | undefined,
): boolean {
  const origin = firstHeaderValue(request.headers.origin);
  if (!origin) {
    return false;
  }
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }
  if (publicOrigin) {
    return normalizedOrigin === normalizeOrigin(publicOrigin);
  }

  const host = request.host;
  if (!host) {
    return false;
  }
  const requestOrigin = normalizeOrigin(`${request.protocol}://${host}`);
  if (normalizedOrigin === requestOrigin) {
    return true;
  }

  return DEV_PROXY_ORIGINS.has(normalizedOrigin) && isLoopbackHost(host);
}

export function isTrustedProxyAddress(
  address: string,
  trustedProxyIps: string[] = [],
): boolean {
  const ip = normalizeIpAddress(address);
  if (isLoopbackAddress(ip)) {
    return true;
  }
  return trustedProxyIps.some(
    (trustedAddress) => normalizeIpAddress(trustedAddress) === ip,
  );
}

export function isLoopbackHost(host: string): boolean {
  const hostname = hostnameFromHostHeader(host);
  if (!hostname) {
    return false;
  }
  const normalized = normalizeIpAddress(hostname).toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function normalizeOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function hostnameFromHostHeader(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0]?.trim();
  }
  return value?.split(",")[0]?.trim();
}

function normalizeIpAddress(address: string): string {
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    return lower.slice("::ffff:".length);
  }
  return lower;
}

function isLoopbackAddress(address: string): boolean {
  return (
    address === "localhost" ||
    address === "::1" ||
    address.startsWith("127.")
  );
}
