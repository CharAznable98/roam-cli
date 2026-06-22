import type { FastifyRequest } from "fastify";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

  return isLoopbackOrigin(normalizedOrigin) && isLoopbackHost(host);
}

export function isTrustedProxyAddress(address: string): boolean {
  const ip = normalizeIpAddress(address);
  if (isPrivateIpv4(ip)) {
    return true;
  }
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "localhost" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80:")
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

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
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
  if (address.startsWith("::ffff:")) {
    return address.slice("::ffff:".length);
  }
  return address;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || second === undefined) {
    return false;
  }
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}
