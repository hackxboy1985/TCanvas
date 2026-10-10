/**
 * 分镜节点「生成参数随模型联动」的解析模块。
 *
 * <p><b>背景</b>：lens 分镜节点（LensShotNode）的 时长 / 画幅 / 分辨率 三个生成参数
 * 必须跟随所选生视频模型的可用范围，否则会下发模型不支持的值，被渠道直接拒绝，
 * 或按模型默认值静默改写 —— 两种结果都与用户所见不符。
 *
 * <p><b>字段来源</b>（对齐后端 {@code LensModelConfigController.toModelJson} 的真实下发结构）：
 * <ul>
 *   <li>时长：{@code others.minDuration} / {@code others.maxDuration}（秒）</li>
 *   <li>画幅：{@code others.supportedRatios}（字符串数组）</li>
 *   <li>分辨率：顶层 {@code resolutions}（后端解析 lens_application.resolutions），
 *       经 {@code toLensModelOptions} 映射到 {@code meta.imageOptions.resolutionOptions}</li>
 * </ul>
 *
 * <p><b>为什么需要兜底</b>：部分存量模型未配置 supportedRatios / resolutions。
 * 此时若返回空数组，下拉将无可选项、用户无法选择。因此按「未配置 → 通用默认值」回退，
 * 保证下拉始终可用；回退值本身仍是真实可下发的值，不属于伪造数据。
 * 而时长不同：时长有明确语义（分镜时长），缺失时返回 null 由调用方显式拦截，不做猜测。
 *
 * <p>本模块为纯函数，无副作用，便于单测覆盖。
 */

/** 模型未配置 supportedRatios 时的兜底画幅 */
export const DEFAULT_ASPECT_OPTIONS: string[] = ['16:9', '9:16']

/** 模型未配置 resolutions 时的兜底分辨率 */
export const DEFAULT_RESOLUTION_OPTIONS: string[] = ['720p', '1080p', '2K']

/** 兜底时长下限（秒）：与分镜板面板 timeOptions 的 minDuration 默认值一致 */
export const DEFAULT_MIN_DURATION = 4

/** 兜底时长上限（秒）：与分镜板面板 timeOptions 的 maxDuration 默认值一致 */
export const DEFAULT_MAX_DURATION = 15

/** lens 模型 meta 的 others 子结构（仅声明本模块用到的键） */
interface LensModelOthers {
  minDuration?: unknown
  maxDuration?: unknown
  supportedRatios?: unknown
}

/** lens 模型 meta 结构（仅声明本模块用到的键） */
interface LensModelMeta {
  others?: LensModelOthers
  imageOptions?: { resolutionOptions?: unknown }
}

/** 把 unknown 收窄成「去空去重后的字符串数组」，非数组或含非字符串项时逐项过滤 */
function toStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** 把 unknown 收窄成「正整数」，非法时返回 null */
function toPositiveInt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const value = Math.trunc(raw)
  return value > 0 ? value : null
}

/**
 * 解析所选模型的生成时长区间（秒）。
 *
 * <p>模型未配置时回退到 {@link DEFAULT_MIN_DURATION}~{@link DEFAULT_MAX_DURATION}；
 * 若下限大于上限（脏配置），整体回退到默认区间，避免生成空选项列表。
 *
 * @param meta 模型 option 的 meta 字段
 * @returns 时长下限与上限（闭区间，单位秒）
 */
export function resolveModelDurationRange(meta: unknown): { min: number; max: number } {
  const others = (meta as LensModelMeta | undefined)?.others
  const min = toPositiveInt(others?.minDuration) ?? DEFAULT_MIN_DURATION
  const max = toPositiveInt(others?.maxDuration) ?? DEFAULT_MAX_DURATION
  if (min > max) return { min: DEFAULT_MIN_DURATION, max: DEFAULT_MAX_DURATION }
  return { min, max }
}

/**
 * 由时长区间生成下拉选项（每秒一项，闭区间）。
 *
 * @param min 下限（秒）
 * @param max 上限（秒）
 * @returns 形如 {@code [{ value: '5', label: '5s' }]} 的选项列表
 */
export function buildDurationOptions(min: number, max: number): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  for (let i = min; i <= max; i++) out.push({ value: String(i), label: `${i}s` })
  return out
}

/**
 * 解析所选模型支持的画幅列表。
 *
 * @param meta 模型 option 的 meta 字段
 * @returns 模型配置的画幅；未配置时返回通用兜底画幅（保证下拉可用）
 */
export function resolveModelAspectOptions(meta: unknown): string[] {
  const configured = toStringList((meta as LensModelMeta | undefined)?.others?.supportedRatios)
  return configured.length > 0 ? configured : DEFAULT_ASPECT_OPTIONS
}

/**
 * 解析所选模型支持的分辨率列表。
 *
 * @param meta 模型 option 的 meta 字段
 * @returns 模型配置的分辨率；未配置时返回通用兜底分辨率（保证下拉可用）
 */
export function resolveModelResolutionOptions(meta: unknown): string[] {
  const configured = toStringList((meta as LensModelMeta | undefined)?.imageOptions?.resolutionOptions)
  return configured.length > 0 ? configured : DEFAULT_RESOLUTION_OPTIONS
}

/**
 * 把当前值收敛到候选列表内的合法值。
 *
 * <p>优先级：候选列表包含当前值 → 保持当前值（不打断用户已选）；
 * 否则用候选列表第一项。列表为空时返回 null，由调用方显式处理。
 *
 * @param current 当前值（可能为 null 或不在候选内）
 * @param options 候选列表
 * @returns 收敛后的值
 */
export function convergeToOptions(current: string | null, options: string[]): string | null {
  if (options.length === 0) return null
  if (current !== null && options.includes(current)) return current
  return options[0]
}

/**
 * 把时长收敛到模型区间内（超界夹到边界，null 保持 null）。
 *
 * @param current 当前时长（秒），可为 null 表示未选择
 * @param min 下限（秒）
 * @param max 上限（秒）
 * @returns 落在区间内的时长，或 null
 */
export function clampDuration(current: number | null, min: number, max: number): number | null {
  if (current === null) return null
  const value = Math.trunc(current)
  if (value < min) return min
  if (value > max) return max
  return value
}
