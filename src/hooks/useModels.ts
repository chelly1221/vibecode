// Model availability belongs to an account, not just a provider.
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, type ModelInfo, type Provider } from "@/lib/ipc";
const cache = new Map<string, ModelInfo[]>();
const inflight = new Map<string, Promise<ModelInfo[]>>();
const keyFor = (provider: Provider, accountId?: string | null) => `${provider}:${accountId ?? "unselected"}`;
export function fetchModels(provider: Provider, force = false, accountId?: string | null): Promise<ModelInfo[]> {
  const key = keyFor(provider, accountId);
  if (!force) {
    const hit = cache.get(key); if (hit) return Promise.resolve(hit);
    const pending = inflight.get(key); if (pending) return pending;
  }
  const p = ipc.tools.listModels(provider, accountId).then((models) => { if (inflight.get(key) === p) cache.set(key, models); return models; })
    .finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p); return p;
}
export function useModels(provider: Provider | null, accountId?: string | null) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  const load = useCallback((force = false) => {
    const request = ++version.current; setError(null);
    if (!provider) { setModels([]); setLoading(false); return; }
    setModels(cache.get(keyFor(provider, accountId)) ?? []); setLoading(true);
    fetchModels(provider, force, accountId).then((m) => { if (request === version.current) setModels(m); })
      .catch((e) => { if (request === version.current) setError(String(e)); })
      .finally(() => { if (request === version.current) setLoading(false); });
  }, [provider, accountId]);
  useEffect(() => { load(); return () => { ++version.current; }; }, [load]);
  return { models, loading, error, reload: () => load(true) };
}
