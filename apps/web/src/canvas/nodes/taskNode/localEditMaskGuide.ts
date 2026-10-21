/**
 * 「局部修改」（历史标识 `depth`）保存时的圈选引导图计算。
 *
 * <p><b>为什么单独抽出来</b>：弹窗每次打开都会把圈选画布重置为空
 * （`maskDirty = false`），但节点上可能已经保存过 `poseMaskUrl`。
 * 如果保存时无脑写 `maskDirty ? 新图 : null`，就会把已保存的引导图清空 ——
 * 用户只是打开弹窗改了提示词，下一次生成却丢了「只改圈选区域」的约束。
 *
 * <p>语义（唯一真源，PoseEditor 与单测共用）：
 * <ul>
 *   <li>本次重新圈选过 → 用新生成的引导图；新图生成失败视为没有引导图（显式失败，不沿用旧图，
 *       否则模型会按旧的圈选区域改，与用户本次操作不一致）</li>
 *   <li>本次显式点过「清除圈选」→ 移除引导图</li>
 *   <li>既没重圈也没清除 → 沿用节点上已保存的引导图（核心修复）</li>
 *   <li>非圈选模式（姿势调整 / 尺寸调整）→ 无引导图</li>
 * </ul>
 */
export function resolveMaskGuideUrlOnSave(input: {
  /** 当前模式是否启用圈选（仅「局部修改」启用） */
  maskEnabled: boolean
  /** 本次是否重新圈选过 */
  maskDirty: boolean
  /** 本次是否显式点过「清除圈选」 */
  maskCleared: boolean
  /** 本次新生成的引导图 URL（未生成时为 null） */
  newMaskGuideUrl?: string | null
  /** 节点上已保存的引导图 URL */
  existingMaskGuideUrl?: string | null
}): string | null {
  if (!input.maskEnabled) return null
  if (input.maskCleared) return null
  if (input.maskDirty) {
    const created = typeof input.newMaskGuideUrl === 'string' ? input.newMaskGuideUrl.trim() : ''
    return created || null
  }
  const existing = typeof input.existingMaskGuideUrl === 'string' ? input.existingMaskGuideUrl.trim() : ''
  return existing || null
}
