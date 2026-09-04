// Model list per provider, cached for the app lifetime.

import { useCallback, useEffect, useState } from "react";
import { ipc, type ModelInfo, type Provider } from "@/lib/ipc";

const cache = new Map<Provider, ModelInfo[]>();
const inflight = new Map<Provider, Promise<ModelInfo[]>>();

export function fetchModels(provider: Provider, force = false): Promise<ModelInfo[]> {
  if (!force) {
    const hit = cache.get(provider);
    if (hit) return Promise.resolve(hit);
    const pending = inflight.get(provider);
    if (pending) return pending;
  }
  const p = ipc.tools
    .listModels(provider)
    .then((models) => {
      cache.set(provider, models);
      return models;
    })
    .finally(() => inflight.delete(provider));
  inflight.set(provider, p);
  return p;
}

export function useModels(provider: Provider | null) {
  const [models, setModels] = useState<ModelInfo[]>(() => (provider ? cache.get(provider) ?? [] : []));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (force = false) => {
      if (!provider) {
        setModels([]);
        return;
      }
      const cached = cache.get(provider);
      if (cached && !force) {
        setModels(cached);
        return;
      }
      setLoading(true);
      setError(null);
      fetchModels(provider, force)
        .then((m) => setModels(m))
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
    },
    [provider],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  return { models, loading, error, reload: () => load(true) };
}
