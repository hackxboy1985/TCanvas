import type { Edge, Node } from '@xyflow/react'

/**
 * lens 画布 flow 合并（reload 专用纯函数）
 *
 * <p>背景：画布 Agent 通过 flow_patch 改写 flow 后，前端需要 reload 把最新数据合并进 store。
 * 合并不能用「store 无条件优先」或「flow 无条件优先」：</p>
 * <ul>
 *   <li>自由节点（用户/AI 建的 taskNode/groupNode）：flow_patch 修改必须生效，所以 data 以 flow 为准；</li>
 *   <li>投影节点（lens 业务数据投影出来的节点）：业务字段随时由 lens 接口重新投影，比 flow 快照新，
 *       所以 data 以 store 为准（flow 只提供位置/类型）。</li>
 * </ul>
 *
 * <p>与 LensCanvasApp#loadEpisode 的投影/编排语义保持一致，避免 agent 写画布后出现
 * 「UI 看不到 AI 修改」或「业务字段被 flow 旧快照覆盖」。</p>
 */

/** 投影节点的 data.source 标记（前端 Lens 投影节点写入） */
const LENS_PROJECTION_SOURCE = 'lens_projection'

/** 分镜投影节点类型（历史数据没有 source 标记，类型本身即身份） */
const LENS_SHOT_NODE_TYPE = 'lensShot'

/**
 * 判断节点是否为 lens 业务投影节点。
 *
 * <p>判定依据（双条件，缺一不可）：
 * - lensShot 分镜节点：类型本身即身份，历史数据不带 source 标记；
 * - 其余投影节点（角色/场景/道具/剧本/台本）：带 source='lens_projection'。</p>
 *
 * @param node 画布节点
 * @returns true 表示投影节点
 */
export function isLensProjectionNode(node: Node): boolean {
  if (node.type === LENS_SHOT_NODE_TYPE) return true
  return (node.data as { source?: string } | undefined)?.source === LENS_PROJECTION_SOURCE
}

/**
 * 边去重键：source/target + 连接手柄。
 *
 * <p>投影引用边可能同时存在于 flow 旧快照和当前 store 投影中，加载/合并时要按同一口径去重，
 * 避免同一条连线渲染两次。</p>
 *
 * @param edge 画布边
 * @returns 去重键
 */
export function buildLensEdgeKey(edge: Edge): string {
  return [edge.source, edge.target, edge.sourceHandle ?? '', edge.targetHandle ?? ''].join('|')
}

/**
 * 收集投影节点 id 集合（可混合传 flow 节点与 store 节点）。
 *
 * <p>flow 里可能残留已被业务删除的投影节点（幽灵节点），它们虽然会在恢复时被过滤掉，
 * 但引用它们的旧边也必须当作投影边丢弃，不能当自由边保留。</p>
 *
 * @param nodes 节点列表
 * @returns 投影节点 id 集合
 */
export function collectLensProjectionNodeIds(nodes: Node[]): Set<string> {
  const projectionNodeIds = new Set<string>()
  for (const node of nodes) {
    if (!node || !isLensProjectionNode(node)) continue
    const nodeId = String(node.id || '').trim()
    if (nodeId) projectionNodeIds.add(nodeId)
  }
  return projectionNodeIds
}

/**
 * 判断是否为投影引用边：任意一端是投影节点即算。
 *
 * @param edge 画布边
 * @param projectionNodeIds 投影节点 id 集合
 * @returns true=投影引用边
 */
export function isLensProjectionEdge(edge: Edge, projectionNodeIds: Set<string>): boolean {
  if (!edge) return false
  return projectionNodeIds.has(String(edge.source || '')) || projectionNodeIds.has(String(edge.target || ''))
}

/**
 * 按 {@link buildLensEdgeKey} 去重，保留先出现的边（顺序稳定，避免每次保存签名抖动）。
 *
 * @param edges 画布边列表
 * @returns 去重后的边
 */
export function dedupeLensEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>()
  const result: Edge[] = []
  for (const edge of edges) {
    if (!edge) continue
    const key = buildLensEdgeKey(edge)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(edge)
  }
  return result
}

/** flow 合并输入 */
export type LensFlowMergeInput = {
  /** flow 中的节点（服务端最新编排） */
  flowNodes: Node[]
  /** flow 中的边（服务端最新编排，只有自由边） */
  flowEdges: Edge[]
  /** 当前 store 中的节点（含最新业务投影快照） */
  currentNodes: Node[]
  /** 当前 store 中的边（含投影引用边；投影边不持久化在 flow 里） */
  currentEdges: Edge[]
}

/** flow 合并结果 */
export type LensFlowMergeResult = {
  /** 合并后的节点 */
  nodes: Node[]
  /** 合并后的边 */
  edges: Edge[]
  /** flow 中新增、当前 store 中不存在的节点 id（供 autoRun 使用） */
  newNodeIds: string[]
}

/**
 * 把 lens 最新 flow 合并进当前画布 store。
 *
 * <p>合并规则：</p>
 * <ol>
 *   <li>flow 中存在的节点：自由节点 data 以 flow 为准（AI patch 生效）；投影节点 data 以 store 为准（业务快照最新）；
 *       位置/类型始终以 flow 为准；</li>
 *   <li>flow 中不存在的当前节点：投影节点保留（flow 只存编排，投影节点可能尚未写入 flow），
 *       自由节点不保留（视为 AI 已删除）。</li>
 * </ol>
 *
 * <p>连线规则：flow 只持久化自由边，投影引用边不落 flow、由业务投影重建。因此合并时
 * **flow 自由边 + 当前 store 中的投影引用边** 一起返回；直接返回 flowEdges 会丢掉投影边，
 * 随后 debounce 自动保存会把缺边状态写回 flow，导致投影连线永久丢失。</p>
 *
 * @param input 合并输入
 * @returns 合并结果（节点/边/新增节点 id）
 */
export function mergeLensFlowIntoStore(input: LensFlowMergeInput): LensFlowMergeResult {
  const { flowNodes, flowEdges, currentNodes, currentEdges } = input
  const currentById = new Map(currentNodes.map((node) => [String(node.id || '').trim(), node] as const))
  const currentNodeIds = new Set(currentById.keys())
  const flowNodeIds = new Set(flowNodes.map((node) => String(node.id || '').trim()).filter(Boolean))
  const newNodeIds = Array.from(flowNodeIds).filter((nodeId) => !currentNodeIds.has(nodeId))

  const merged: Node[] = []
  for (const flowNode of flowNodes) {
    const nodeId = String(flowNode.id || '').trim()
    if (!nodeId) continue
    const existing = currentById.get(nodeId)
    if (!existing) {
      merged.push(flowNode)
      continue
    }
    // 关键顺序：自由节点 data 以 flow 为准（否则 AI patch 不生效）；投影节点 data 以 store 为准（业务字段最新）
    const data = isLensProjectionNode(existing)
      ? { ...(flowNode.data || {}), ...(existing.data || {}) }
      : { ...(existing.data || {}), ...(flowNode.data || {}) }
    merged.push({
      ...existing,
      ...(flowNode.type ? { type: flowNode.type } : {}),
      position: flowNode.position ?? existing.position,
      data,
    })
  }

  // flow 只存编排，投影节点可能尚未写入 flow：保留当前 store 中的投影节点
  for (const node of currentNodes) {
    const nodeId = String(node.id || '').trim()
    if (!nodeId || flowNodeIds.has(nodeId)) continue
    if (isLensProjectionNode(node)) merged.push(node)
  }

  // 连线合并：flow 自由边 + 当前 store 的投影引用边（投影边不持久化在 flow，属于业务投影产物）。
  // 去重口径 source/target/handle：flow 里若有历史遗留的投影边会被丢弃，以投影重建结果为准。
  const projectionNodeIds = collectLensProjectionNodeIds([...flowNodes, ...currentNodes])
  const flowFreeEdges = flowEdges.filter((edge) => !isLensProjectionEdge(edge, projectionNodeIds))
  const currentProjectionEdges = currentEdges.filter((edge) => isLensProjectionEdge(edge, projectionNodeIds))
  const edges = dedupeLensEdges([...flowFreeEdges, ...currentProjectionEdges])

  return { nodes: merged, edges, newNodeIds }
}
