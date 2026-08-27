import type { ModelOption, ModelOptionPricing } from './models'
import type { NodeKind } from './models'

function normalizeNonNegativeInteger(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function normalizeQuantity(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(1, Math.floor(value))
}

function normalizeSpecKey(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

type SpecCondition = { field: string; value: string }

// 解析规格条件：resolution:2K&&quality:medium -> [{field:"resolution",value:"2k"},{field:"quality",value:"medium"}]
function parseSpecConditions(specKey: string): SpecCondition[] {
  return specKey
    .split('&&')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const separatorIndex = segment.indexOf(':')
      if (separatorIndex <= 0) return null
      const field = segment.slice(0, separatorIndex).trim().toLowerCase()
      const value = segment.slice(separatorIndex + 1).trim().toLowerCase()
      if (!field || !value) return null
      return { field, value }
    })
    .filter((item): item is SpecCondition => item !== null)
}

// 判断某条规格的全部条件是否都命中字段值
function matchSpecConditions(
  conditions: SpecCondition[],
  specValues: Record<string, string>,
): boolean {
  if (conditions.length === 0) return false
  return conditions.every((condition) => {
    const raw = specValues[condition.field]
    return typeof raw === 'string' && raw.trim().toLowerCase() === condition.value
  })
}

// 从多条规格里选出命中者：条件数最多（最具体）优先
function pickMatchedSpecCost(
  specCosts: ReadonlyArray<{ specKey: string; cost: number; enabled: boolean }>,
  specValues: Record<string, string>,
): number | null {
  let best: { cost: number; conditionCount: number } | null = null
  for (const spec of specCosts) {
    if (!spec.enabled) continue
    const conditions = parseSpecConditions(spec.specKey)
    if (conditions.length === 0) continue
    if (!matchSpecConditions(conditions, specValues)) continue
    const cost = normalizeNonNegativeInteger(spec.cost)
    if (!best || conditions.length > best.conditionCount) {
      best = { cost, conditionCount: conditions.length }
    }
  }
  return best ? best.cost : null
}

function defaultCostForNodeKind(kind: NodeKind | null | undefined): number {
  if (kind === 'image' || kind === 'imageEdit') return 1
  if (kind === 'video') return 10
  return 0
}

function resolveUnitCostFromPricing(
  pricing: ModelOptionPricing | null | undefined,
  specKey: string,
): number | null {
  if (!pricing) return null
  if (specKey) {
    for (const spec of pricing.specCosts) {
      if (normalizeSpecKey(spec.specKey) !== specKey) continue
      if (!spec.enabled) break
      return normalizeNonNegativeInteger(spec.cost)
    }
  }
  if (!pricing.enabled) return null
  return normalizeNonNegativeInteger(pricing.cost)
}

export function resolveModelGenerationCredits(input: {
  kind: NodeKind | null | undefined
  modelOption?: Pick<ModelOption, 'pricing'> | null
  specKey?: string | null
  specValues?: Record<string, string> | null
  quantity?: number | null
}): number {
  const pricing = input.modelOption?.pricing
  let unitCost: number | null = null
  // 1. 字段条件匹配（specKey 形如 resolution:2K&&quality:medium）
  if (pricing && input.specValues && Object.keys(input.specValues).length > 0) {
    unitCost = pickMatchedSpecCost(pricing.specCosts, input.specValues)
  }
  // 2. 精确 specKey 匹配（视频等）
  if (unitCost === null) {
    unitCost = resolveUnitCostFromPricing(pricing, normalizeSpecKey(input.specKey))
  }
  const finalUnitCost = unitCost ?? defaultCostForNodeKind(input.kind)
  return finalUnitCost * normalizeQuantity(input.quantity)
}
