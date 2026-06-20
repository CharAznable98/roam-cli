import type {
  AgentKind,
  AgentSkillListResult,
  ApiAgentSkillList,
  ApiPathSearch,
  PathSearchResult,
} from "@roamcli/shared/protocol";

export const AGENT_SKILL_CACHE_TTL_MS = 60 * 60 * 1000;
export const PATH_SEARCH_CACHE_TTL_MS = 60 * 1000;

export type PromptResourceScope = {
  runnerId: string;
  agent: AgentKind;
  basePath: string;
};

export type AgentSkillFetcher = (
  input: ApiAgentSkillList,
) => Promise<AgentSkillListResult>;

export type PathSearchFetcher = (
  input: ApiPathSearch,
) => Promise<PathSearchResult>;

export type CacheEntry<T> = {
  result: T;
  cachedAt: number;
};

const agentSkillCache = new Map<string, CacheEntry<AgentSkillListResult>>();
const pathSearchCache = new Map<string, CacheEntry<PathSearchResult>>();

export function getCachedAgentSkills(
  scope: PromptResourceScope,
): CacheEntry<AgentSkillListResult> | undefined {
  return agentSkillCache.get(agentSkillCacheKey(scope));
}

export function isAgentSkillCacheFresh(
  entry: CacheEntry<AgentSkillListResult>,
  now = Date.now(),
): boolean {
  return now - entry.cachedAt < AGENT_SKILL_CACHE_TTL_MS;
}

export async function refreshAgentSkills(
  scope: PromptResourceScope,
  fetcher: AgentSkillFetcher,
): Promise<CacheEntry<AgentSkillListResult>> {
  const result = await fetcher({
    runnerId: scope.runnerId,
    agent: scope.agent,
    basePath: scope.basePath,
  });
  const entry = { result, cachedAt: Date.now() };
  agentSkillCache.set(agentSkillCacheKey(scope), entry);
  return entry;
}

export function getCachedPathSearch(
  scope: Pick<PromptResourceScope, "runnerId" | "basePath">,
  query: string,
  limit: number,
): CacheEntry<PathSearchResult> | undefined {
  return pathSearchCache.get(pathSearchCacheKey(scope, query, limit));
}

export function isPathSearchCacheFresh(
  entry: CacheEntry<PathSearchResult>,
  now = Date.now(),
): boolean {
  return now - entry.cachedAt < PATH_SEARCH_CACHE_TTL_MS;
}

export async function refreshPathSearch(
  scope: Pick<PromptResourceScope, "runnerId" | "basePath">,
  query: string,
  limit: number,
  fetcher: PathSearchFetcher,
): Promise<CacheEntry<PathSearchResult>> {
  const result = await fetcher({
    runnerId: scope.runnerId,
    basePath: scope.basePath,
    query,
    limit,
  });
  const entry = { result, cachedAt: Date.now() };
  pathSearchCache.set(pathSearchCacheKey(scope, query, limit), entry);
  return entry;
}

export function clearPromptResourceCaches(): void {
  agentSkillCache.clear();
  pathSearchCache.clear();
}

function agentSkillCacheKey(scope: PromptResourceScope): string {
  return [scope.runnerId, scope.agent, scope.basePath].join("\0");
}

function pathSearchCacheKey(
  scope: Pick<PromptResourceScope, "runnerId" | "basePath">,
  query: string,
  limit: number,
): string {
  return [scope.runnerId, scope.basePath, query, String(limit)].join("\0");
}
