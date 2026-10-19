import { collectPublicFlowAnchorBindingImageUrls } from '@tapcanvas/flow-anchor-bindings'

type AssetInputLike = {
  url?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRemoteUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : ''
}

function uniqueUrls(items: string[], limit: number): string[] {
  const maxItems = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0
  if (maxItems === 0) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const normalized = readRemoteUrl(item)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= maxItems) break
  }
  return out
}

function normalizeReferenceImageUrls(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return uniqueUrls(
    value
      .map((item) => (typeof item === 'string' ? item : ''))
      .filter(Boolean),
    limit,
  )
}

function normalizeAssetInputUrls(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const candidates: string[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const url = readRemoteUrl((item as AssetInputLike).url)
    if (!url) continue
    candidates.push(url)
    if (candidates.length >= limit) break
  }
  return uniqueUrls(candidates, limit)
}

/** 读取实体ID字段，统一归一成去空格字符串；非法或为空返回空串。 */
function readEntityId(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return ''
}

/**
 * 排除「锚点绑定指向节点自己」的那条绑定资源。
 *
 * <p><b>为什么排除</b>：业务投影节点（角色/场景/道具）在 {@code anchorBindings} 里
 * 把自己绑到自己身上，{@code imageUrl} 就是该资产<b>已有的图</b>。这类图不是用户
 * 在参考区选择的参考图，而是投影自动写入的身份信息；把它当参考图提交，会让
 * 「<b>无上游参考却带了图</b>」——界面参考区是空的（那里只渲染连线来源），
 * 提交却带着旧图，属于显示与提交不一致，且生成结果会被旧图锚死。
 *
 * <p><b>不在本函数处理父实体</b>：子角色/子场景需要的父图，由画布已建的
 * 「父→子派生连线」进入上游参考区统一提供（见 LensCanvasApp.pushDerivedEdges），
 * 与其它上游参考走同一条链路，无需在这里特殊拼接。
 *
 * <p><b>不修改节点数据</b>：{@code anchorBindings} 仍要供下游节点收集参考图，
 * 这里只在「节点为自身收集参考图」时过滤返回值。
 *
 * @param bindings 节点锚点绑定
 * @param selfEntityId 节点自身的实体ID
 * @returns 去掉自身绑定后的数组
 */
function excludeSelfAnchorBindings(bindings: unknown, selfEntityId: unknown): unknown[] {
  if (!Array.isArray(bindings)) return []
  const self = readEntityId(selfEntityId)
  if (!self) return bindings
  return bindings.filter((binding) => {
    if (!isRecord(binding)) return true
    return readEntityId(binding.entityId) !== self
  })
}

export function collectNodeReferenceImageUrls(nodeData: unknown, limit = 8): string[] {
  if (!isRecord(nodeData)) return []
  // 用户在参考区显式添加的图（referenceImages / assetInputs）原样保留 —— 用户主动选图
  // 就是要它是参考图，不做任何自动过滤。
  // 只过滤 anchorBindings 里的「自身旧图」：那是画布投影自动写入的，不是用户选择。
  return uniqueUrls(
    [
      ...normalizeReferenceImageUrls(nodeData.referenceImages, limit),
      ...collectPublicFlowAnchorBindingImageUrls(
        excludeSelfAnchorBindings(nodeData.anchorBindings, nodeData.entityId),
        limit,
      ),
      ...normalizeReferenceImageUrls(nodeData.roleCardReferenceImages, limit),
      ...normalizeAssetInputUrls(nodeData.assetInputs, limit),
    ],
    limit,
  )
}

export function readNodeFirstFrameUrl(nodeData: unknown): string {
  if (!isRecord(nodeData)) return ''
  return readRemoteUrl(nodeData.firstFrameUrl) || readRemoteUrl(nodeData.veoFirstFrameUrl)
}

export function readNodeLastFrameUrl(nodeData: unknown): string {
  if (!isRecord(nodeData)) return ''
  return readRemoteUrl(nodeData.lastFrameUrl) || readRemoteUrl(nodeData.veoLastFrameUrl)
}
