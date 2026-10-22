import { getImageModels, getImage2ImageModels, type LensModelOption } from '../../api/lens'

/**
 * 应用列表的 sessionStorage 缓存键。
 *
 * <p>模型列表属于「配置接口」，按项目约定（AGENTS.md 画布长期约定第 4 条）：
 * 一次页面会话内只请求一次，结果存 sessionStorage，刷新页面后才会重新请求，
 * 避免任务面板/抽屉反复挂载、轮询时各个组件重复调接口。
 */
const LENS_ASSET_APPLICATIONS_STORAGE_KEY = 'lens_asset_task_applications'

/** 进行中的请求：并发调用共享同一个 Promise，避免一屏多个节点同时挂载时打 N 次接口 */
let inflightApplications: Promise<LensModelOption[]> | null = null

/**
 * 读取 sessionStorage 中缓存的应用列表。
 *
 * <p>解析失败（数据损坏、旧格式）时清掉该键并返回 null，由调用方重新请求，
 * 不能把损坏数据当空列表静默使用。
 *
 * @returns 缓存的应用列表；无缓存或数据非法时返回 null
 */
function readCachedApplications(): LensModelOption[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(LENS_ASSET_APPLICATIONS_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      window.sessionStorage.removeItem(LENS_ASSET_APPLICATIONS_STORAGE_KEY)
      return null
    }
    return parsed as LensModelOption[]
  } catch {
    try {
      window.sessionStorage.removeItem(LENS_ASSET_APPLICATIONS_STORAGE_KEY)
    } catch {
      // ignore
    }
    return null
  }
}

/**
 * 把应用列表写入 sessionStorage 缓存。
 *
 * <p>写入失败（隐私模式、超出配额）只降级为不缓存，不影响本次结果返回。
 *
 * @param models 应用列表
 */
function writeCachedApplications(models: LensModelOption[]): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(LENS_ASSET_APPLICATIONS_STORAGE_KEY, JSON.stringify(models))
  } catch {
    // ignore
  }
}

/** 与资产编辑页同源：合并已启用的文生图、图生图应用并去重，不写死应用ID。 */
export async function loadLensAssetTaskApplicationIds(): Promise<string[]> {
  const models = await loadLensAssetTaskApplications()
  const ids = models.filter((model) => model.enabled === true).map((model) => String(model.value))
  if (!ids.length) throw new Error('当前未配置可用生图应用，无法筛选资产任务')
  return ids
}

/**
 * 加载查询筛选与展示所需的应用列表（合并文生图 + 图生图并去重）。
 *
 * <p><b>缓存策略</b>：结果存 sessionStorage，同一页面会话内只请求一次，
 * 期间任何组件（任务面板、右侧抽屉）调用都直接复用；
 * 并发调用还共享同一个在途请求，避免多个节点同时挂载时打 N 次接口。
 *
 * <p>失败不写缓存（异常直接抛给调用方），保证下次调用能真实重试。
 *
 * @param forceRefresh 是否跳过缓存强制重新拉取（模型管理改配置后需要即时生效时用）
 * @returns 应用列表（停用项保留，便于历史任务显示名称而不是内部模型）
 */
export async function loadLensAssetTaskApplications(forceRefresh = false): Promise<LensModelOption[]> {
  if (!forceRefresh) {
    const cached = readCachedApplications()
    if (cached) return cached
  }
  if (inflightApplications) return inflightApplications

  const request = (async (): Promise<LensModelOption[]> => {
    const groups = await Promise.all([getImageModels(), getImage2ImageModels()])
    const models = [...new Map(groups.flat().map((model) => [String(model.value), model])).values()]
    // 成功才写缓存，失败保持无缓存以便重试
    writeCachedApplications(models)
    return models
  })()

  inflightApplications = request
  try {
    return await request
  } finally {
    // 无论成功失败都移除在途登记，避免失败后后续调用永远复用同一个 reject 的 Promise
    inflightApplications = null
  }
}

/**
 * 作废应用列表缓存（模型管理/应用启停配置变更后调用，保证下次读到最新配置）。
 */
export function invalidateLensAssetTaskApplicationsCache(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(LENS_ASSET_APPLICATIONS_STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** 仅按原始应用ID解析显示名，不拿内部模型名冒充应用名。 */
export function resolveLensTaskApplicationName(originAppId: string | number | undefined, models: readonly LensModelOption[]): string {
  const id = originAppId === undefined ? '' : String(originAppId).trim()
  if (!id) return '应用ID缺失'
  const name = models.find((model) => String(model.value) === id)?.label?.trim()
  return name || '未匹配应用（' + id + '）'
}
