import { Prisma } from '@prisma/client';
import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';

/**
 * Token usage & cost reporting (super-admin only). Source of truth is
 * ai_provider_attempts — every LLM call through the provider gateway lands
 * there with workspace, operation, provider, model and token counts (cache
 * token columns added Jul 10 alongside prompt caching).
 *
 * Costs are ESTIMATES from the published per-model list prices below, in USD
 * per million tokens, converted to CAD with a configurable rate. Anthropic
 * reports input_tokens EXCLUDING cached tokens (cache writes/reads are billed
 * separately); OpenAI reports input_tokens INCLUDING the cached portion.
 */
export const MODEL_PRICING_USD_PER_MTOK = [
  // [model prefix, input, output, cacheWrite, cacheRead]
  ['claude-opus', 15, 75, 18.75, 1.50],
  ['claude-sonnet', 3, 15, 3.75, 0.30],
  ['claude-haiku', 1, 5, 1.25, 0.10],
  ['gpt-5.5', 1.25, 10, 0, 0.125],
  ['gpt-5', 1.25, 10, 0, 0.125],
  ['gpt-4o', 2.50, 10, 0, 1.25],
];
const DEFAULT_PRICING = [3, 15, 3.75, 0.30];
const USD_CAD_SETTING_KEY = 'ai_usage_usd_cad_rate';
export const DEFAULT_USD_CAD = 1.37;

function pricingFor(model) {
  const m = String(model || '').toLowerCase();
  const hit = MODEL_PRICING_USD_PER_MTOK.find(([prefix]) => m.startsWith(prefix));
  return hit ? hit.slice(1) : DEFAULT_PRICING;
}

export function costUsdFor({ provider, model, inputTokens = 0, outputTokens = 0, cacheCreationInputTokens = 0, cacheReadInputTokens = 0 }) {
  const [inRate, outRate, cwRate, crRate] = pricingFor(model);
  // OpenAI's input_tokens INCLUDES cached tokens — carve them out so the
  // cached portion is billed at the discounted rate, not double-counted.
  const plainInput = provider === 'openai'
    ? Math.max(0, inputTokens - cacheReadInputTokens)
    : inputTokens;
  return (
    (plainInput * inRate)
    + (outputTokens * outRate)
    + (cacheCreationInputTokens * cwRate)
    + (cacheReadInputTokens * crRate)
  ) / 1_000_000;
}

class TokenUsageService {
  async getUsdCadRate() {
    const raw = await settingsRepository.get(USD_CAD_SETTING_KEY).catch(() => null);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_USD_CAD;
  }

  async setUsdCadRate(rate) {
    const parsed = Number(rate);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10) {
      throw new Error('Rate must be a positive number (CAD per USD)');
    }
    await settingsRepository.set(USD_CAD_SETTING_KEY, String(parsed));
    return parsed;
  }

  /**
   * Full usage report across ALL workspaces (caller must be a super admin).
   * @param {object} opts
   * @param {number} [opts.days=30] history window
   * @param {number|null} [opts.workspaceId] optional single-workspace focus
   */
  async report({ days = 30, workspaceId = null } = {}) {
    const clampedDays = Math.min(Math.max(Number(days) || 30, 1), 365);
    const since = new Date(Date.now() - clampedDays * 24 * 60 * 60 * 1000);
    const wsFilter = workspaceId ? Prisma.sql`AND workspace_id = ${Number(workspaceId)}` : Prisma.empty;

    const groupRows = await prisma.$queryRaw(Prisma.sql`
      SELECT workspace_id, operation, provider, model,
             DATE(started_at) AS day,
             COUNT(*)::int AS calls,
             COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
             COALESCE(SUM(cache_creation_input_tokens), 0)::bigint AS cache_write_tokens,
             COALESCE(SUM(cache_read_input_tokens), 0)::bigint AS cache_read_tokens
      FROM ai_provider_attempts
      WHERE started_at >= ${since} ${wsFilter}
      GROUP BY workspace_id, operation, provider, model, DATE(started_at)`);

    const usdCad = await this.getUsdCadRate();
    const workspaces = await prisma.workspace.findMany({ select: { id: true, name: true } });
    const wsNames = new Map(workspaces.map((w) => [w.id, w.name]));

    const mk = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0 });
    const add = (bucket, row, costUsd) => {
      bucket.calls += row.calls;
      bucket.inputTokens += Number(row.input_tokens);
      bucket.outputTokens += Number(row.output_tokens);
      bucket.cacheWriteTokens += Number(row.cache_write_tokens);
      bucket.cacheReadTokens += Number(row.cache_read_tokens);
      bucket.costUsd += costUsd;
    };

    const overall = mk();
    const byWorkspace = new Map();
    const byOperation = new Map();
    const byModel = new Map();
    const byDay = new Map();

    for (const row of groupRows) {
      const costUsd = costUsdFor({
        provider: row.provider,
        model: row.model,
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        cacheCreationInputTokens: Number(row.cache_write_tokens),
        cacheReadInputTokens: Number(row.cache_read_tokens),
      });
      add(overall, row, costUsd);
      const dayKey = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10);
      for (const [map, key] of [
        [byWorkspace, row.workspace_id],
        [byOperation, row.operation],
        [byModel, `${row.provider}/${row.model}`],
        [byDay, dayKey],
      ]) {
        if (!map.has(key)) map.set(key, mk());
        add(map.get(key), row, costUsd);
      }
    }

    const finish = (bucket) => ({
      ...bucket,
      costUsd: Number(bucket.costUsd.toFixed(4)),
      costCad: Number((bucket.costUsd * usdCad).toFixed(4)),
    });

    return {
      windowDays: clampedDays,
      since: since.toISOString(),
      usdCadRate: usdCad,
      pricingUsdPerMtok: MODEL_PRICING_USD_PER_MTOK,
      overall: finish(overall),
      byWorkspace: [...byWorkspace.entries()]
        .map(([id, b]) => ({ workspaceId: id, workspaceName: wsNames.get(id) || `Workspace ${id}`, ...finish(b) }))
        .sort((a, b) => b.costUsd - a.costUsd),
      byOperation: [...byOperation.entries()]
        .map(([operation, b]) => ({ operation, ...finish(b) }))
        .sort((a, b) => b.costUsd - a.costUsd),
      byModel: [...byModel.entries()]
        .map(([model, b]) => ({ model, ...finish(b) }))
        .sort((a, b) => b.costUsd - a.costUsd),
      byDay: [...byDay.entries()]
        .map(([day, b]) => ({ day, ...finish(b) }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    };
  }
}

export default new TokenUsageService();
