/**
 * 同轮对话内多次 flow_patch 的 reload 编排（纯逻辑，便于单测）。
 *
 * <p>为什么不能只 reload 第一次：agent 一轮里可能连续 patch（先建节点+连线，再补提示词或删除节点），
 * 每次 patch 后服务端画布数据都变化，必须按提交顺序依次 reload。</p>
 *
 * <p>常见坑：</p>
 * <ul>
 *   <li>只 reload 第一次：后续删除的节点会以"幽灵节点"残留在 UI，自动保存还会把它写回；</li>
 *   <li>只按最后一次 reload 的新节点集合 autoRun：第二次 reload 时第一批节点已在 store 中，
 *       相对 store 不再是"新节点"，会漏掉第一次创建的节点；因此这里累积每次 reload 的 newNodeIds；</li>
 *   <li>reload 失败后不清状态：result 阶段兜底 reload 会误以为已有 reload 可复用，不会真正重试。</li>
 * </ul>
 */

/** 单次 flow_patch 后 reload 的结果 */
export type FlowPatchReloadResult = {
  /** 是否真正执行了 reload */
  reloaded: boolean
  /** 相对当时画布 store 新增的节点 id */
  newNodeIds: string[]
  /** 本轮是否发生过 reload 失败（result 阶段据此兜底重试，即使最后一次成功） */
  failed?: boolean
}

/** reload 执行器（注入 reloadCanvasFlowFromServer） */
export type FlowPatchReloadExecutor = () => Promise<FlowPatchReloadResult>

/**
 * 合并节点 id 列表（去重且保持顺序）。
 *
 * @param current  已有 id
 * @param incoming 新增 id
 * @returns 合并后的 id 列表
 */
export function mergeNodeIds(current: string[], incoming: string[]): string[] {
  const seen = new Set(current)
  const merged = [...current]
  for (const nodeId of incoming) {
    if (nodeId && !seen.has(nodeId)) {
      seen.add(nodeId)
      merged.push(nodeId)
    }
  }
  return merged
}

/**
 * 过滤掉 reload 后已不存在的节点 id（避免给已删除的节点 autoRun 提交任务）。
 *
 * @param nodeIds    待过滤 id
 * @param liveNodeIds reload 后画布中仍存在的节点 id
 * @returns 仍存在的 id
 */
export function filterLiveNodeIds(nodeIds: string[], liveNodeIds: Set<string>): string[] {
  return nodeIds.filter((nodeId) => liveNodeIds.has(nodeId))
}

/**
 * 多次 flow_patch 的串行 reload 链。
 *
 * <p>生命周期：一轮对话内复用同一个实例；result 阶段调用 {@link take} 等待全部 reload 完成并拿到累积
 * newNodeIds，然后重建实例。</p>
 */
export class FlowPatchReloadChain {
  /** 进行中的串行链（null 表示没有未完成的 reload） */
  private chain: Promise<FlowPatchReloadResult> | null = null

  /** 累积每次 reload 相对当时 store 的新节点 id */
  private accumulatedNewNodeIds: string[] = []

  /** 本轮是否发生过 reload 失败 */
  private failed = false

  /** reload 执行器 */
  private readonly reload: FlowPatchReloadExecutor

  /**
   * 构造 reload 链。
   *
   * @param reload reload 执行器
   */
  constructor(reload: FlowPatchReloadExecutor) {
    this.reload = reload
  }

  /**
   * 追加一次 reload 任务（串行执行；单次失败不阻塞后续，也不会打断已排队的任务）。
   *
   * @returns 本次任务完成后的结果
   */
  schedule(): Promise<FlowPatchReloadResult> {
    const previous = this.chain ?? Promise.resolve<FlowPatchReloadResult>({ reloaded: false, newNodeIds: [] })
    const next: Promise<FlowPatchReloadResult> = previous
      .then(() => this.reload())
      .then((result) => {
        if (result.reloaded && result.newNodeIds.length > 0) {
          this.accumulatedNewNodeIds = mergeNodeIds(this.accumulatedNewNodeIds, result.newNodeIds)
        }
        return result
      })
      .catch(() => {
        // 单次 reload 失败：标记 failed 并清掉链尾指针，让 result 阶段兜底 reload 能真正重试
        this.failed = true
        if (this.chain === next) {
          this.chain = null
        }
        return { reloaded: false, newNodeIds: [] }
      })
    this.chain = next
    return next
  }

  /**
   * 是否还有未完成的 reload。
   *
   * @returns true 表示有进行中的 reload
   */
  hasPending(): boolean {
    return this.chain !== null
  }

  /**
   * 等待全部已排队 reload 完成，返回合并结果（含累积 newNodeIds），并重置累积状态。
   *
   * @returns 合并后的 reload 结果
   */
  async take(): Promise<FlowPatchReloadResult> {
    const chain = this.chain
    this.chain = null
    const failedBefore = this.failed
    if (!chain) {
      const accumulated = this.accumulatedNewNodeIds
      this.accumulatedNewNodeIds = []
      this.failed = false
      return { reloaded: accumulated.length > 0, newNodeIds: accumulated, failed: failedBefore }
    }
    try {
      const result = await chain
      const newNodeIds = mergeNodeIds(result.newNodeIds, this.accumulatedNewNodeIds)
      const failed = failedBefore || this.failed
      this.accumulatedNewNodeIds = []
      this.failed = false
      return { reloaded: result.reloaded || newNodeIds.length > 0, newNodeIds, failed }
    } catch {
      this.accumulatedNewNodeIds = []
      this.failed = false
      return { reloaded: false, newNodeIds: [], failed: true }
    }
  }
}
