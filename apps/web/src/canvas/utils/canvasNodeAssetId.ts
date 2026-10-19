/**
 * 画布自由节点的任务归属辅助模块。
 *
 * <p><b>背景</b>：画布自由节点（无对应业务实体的 image / imageEdit 节点）没有
 * lens_role / lens_asset_image 记录，产出不落资产。但「任务结果展开」需要按节点
 * 查历史任务，因此提交时必须把归属写进 task_queue：
 * <ul>
 *   <li>{@code scene_id} = 画布 flowId（隔离不同画布）</li>
 *   <li>{@code asset_type} = 10（标记为画布自由节点）</li>
 *   <li>{@code asset_id} = 节点数字ID（匹配到具体节点）</li>
 * </ul>
 *
 * <p>本模块只负责"节点数字ID"的分配与读取。设计要点：
 * <ol>
 *   <li><b>必须持久化到 flow 数据</b>：节点数字ID 存在节点 data 里，随 flow 保存/恢复，
 *       保证刷新、切集、协作方打开画布后仍是同一个值；否则历史任务会对不上节点。</li>
 *   <li><b>只在全画布范围内唯一</b>：用 flow 内当前最大已分配值 +1 递增。
 *       不同 flow 允许重复，因为查询时用 scene_id=flowId 做了隔离。</li>
 *   <li><b>纯函数</b>：不产生副作用，调用方负责把新节点写回 store。</li>
 * </ol>
 */

/** 节点 data 里存放画布资产数字ID的字段名 */
export const CANVAS_NODE_ASSET_ID_FIELD = 'canvasNodeAssetId'

/**
 * 当前画布编排ID（lens_canvas_flow.id）。
 *
 * <p>模块级持有：提交任务发生在 runner 内部，拿不到 React 上下文，
 * 因此由 LensCanvasApp 在 flow 加载/保存后主动写入。
 * 未加载 flow 时为 null，此时提交不传归属（后端按无归属处理）。
 */
let currentLensCanvasFlowId: number | null = null

/**
 * 设置当前画布编排ID（由 LensCanvasApp 在 getFlow/saveFlow 后调用）。
 *
 * <p>后端 {@code LensCanvasFlow.id} 用 ToStringSerializer 序列化，因此传进来是
 * 字符串（也可能是 null）；这里统一归一成数字，非法值视为"无编排"。
 *
 * @param flowId 编排ID（字符串或数字）；传 null/非法值表示当前无编排
 */
export function setLensCanvasFlowId(flowId: string | number | null | undefined): void {
  const num = typeof flowId === 'number' ? flowId : Number(flowId)
  currentLensCanvasFlowId = Number.isFinite(num) && num > 0 ? Math.trunc(num) : null
}

/**
 * 读取当前画布编排ID。
 *
 * @returns 编排ID；未设置时返回 undefined
 */
export function getLensCanvasFlowId(): number | undefined {
  return currentLensCanvasFlowId === null ? undefined : currentLensCanvasFlowId
}

/**
 * 从节点 data 读取已分配的画布资产数字ID。
 *
 * @param data 节点 data
 * @returns 合法的正整数字段值；未分配或非法时返回 null
 */
export function readCanvasNodeAssetId(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null
  const raw = (data as Record<string, unknown>)[CANVAS_NODE_ASSET_ID_FIELD]
  const num = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(num) || num <= 0) return null
  return Math.trunc(num)
}

/**
 * 计算下一个可用的画布资产数字ID。
 *
 * <p>取当前所有节点已分配ID的最大值 +1，避免与历史值冲突。
 * 注意不能用「节点数量 +1」：删除节点后复用编号会把新节点的任务
 * 与已删除节点的历史任务混在一起。
 *
 * @param nodes 画布上全部节点（含未分配ID的节点）
 * @returns 下一个可用ID（最小为 1）
 */
export function nextCanvasNodeAssetId(nodes: ReadonlyArray<{ data?: unknown }>): number {
  let max = 0
  for (const node of nodes) {
    const id = readCanvasNodeAssetId(node.data)
    if (id !== null && id > max) max = id
  }
  return max + 1
}

/**
 * 确保节点拥有画布资产数字ID，返回可直接写回节点 data 的补丁。
 *
 * <p>已分配则原样返回（幂等）；未分配则分配一个新ID。
 * 调用方需在提交任务前调用本函数并把补丁写回节点，再保存 flow，
 * 否则刷新后节点ID会重新分配，历史任务无法匹配。
 *
 * @param node 目标节点
 * @param allNodes 画布上全部节点，用于计算下一个可用ID
 * @returns 节点 data 补丁（含 canvasNodeAssetId）；节点已有ID时返回该ID
 */
export function ensureCanvasNodeAssetId(
  node: { data?: unknown },
  allNodes: ReadonlyArray<{ data?: unknown }>,
): { [CANVAS_NODE_ASSET_ID_FIELD]: number } {
  const existing = readCanvasNodeAssetId(node.data)
  if (existing !== null) {
    return { [CANVAS_NODE_ASSET_ID_FIELD]: existing }
  }
  return { [CANVAS_NODE_ASSET_ID_FIELD]: nextCanvasNodeAssetId(allNodes) }
}

/**
 * 判断节点是否为"自由节点"（无业务实体身份，需要走画布资产归属）。
 *
 * <p>有 entityId 的节点是业务节点投影（角色/场景/道具/分镜），它们走各自
 * 的业务查询（assetType=0/1/2 或 storyboardId），不能用画布归属。
 *
 * @param data 节点 data
 * @returns 是自由节点返回 true
 */
export function isCanvasFreeNode(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const entityId = (data as Record<string, unknown>).entityId
  return entityId === undefined || entityId === null || String(entityId).trim() === ''
}
