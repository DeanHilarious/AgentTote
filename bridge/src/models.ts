import type { Adapter, AgentKind, ModelOption } from './types.ts';

const MODEL_CACHE_MS = 10 * 60 * 1000;

/** Shared by discovery and task validation. Failed lookups are never cached. */
export class ModelCatalog {
  private cache = new Map<AgentKind, { expires: number; models: ModelOption[] }>();
  private pending = new Map<AgentKind, Promise<ModelOption[]>>();

  async list(adapter: Adapter): Promise<ModelOption[]> {
    const cached = this.cache.get(adapter.kind);
    if (cached && cached.expires > Date.now()) return cached.models;
    const pending = this.pending.get(adapter.kind);
    if (pending) return pending;
    const request = Promise.resolve().then(async () => {
      try {
        const models = await adapter.listModels?.() ?? [];
        this.cache.set(adapter.kind, { models, expires: Date.now() + MODEL_CACHE_MS });
        return models;
      } finally {
        this.pending.delete(adapter.kind);
      }
    });
    this.pending.set(adapter.kind, request);
    return request;
  }
}

export function validateModel(models: ModelOption[], model?: string, effort?: string): void {
  const selected = model === undefined ? models.find(option => option.isDefault) : models.find(option => option.id === model);
  if (model !== undefined && !selected) throw new Error(`Unknown model ${model}`);
  if (effort !== undefined && !selected?.efforts?.includes(effort)) {
    throw new Error(`${model ?? selected?.id ?? 'Default'} doesn't support effort ${effort}`);
  }
}
