import { getImageModels, getImage2ImageModels, type LensModelOption } from '../../api/lens'

/** 与资产编辑页同源：合并已启用的文生图、图生图应用并去重，不写死应用ID。 */
export async function loadLensAssetTaskApplicationIds(): Promise<string[]> {
  const models = await loadLensAssetTaskApplications()
  const ids = models.filter((model) => model.enabled === true).map((model) => String(model.value))
  if (!ids.length) throw new Error('当前未配置可用生图应用，无法筛选资产任务')
  return ids
}

/** 同次加载查询筛选与展示所需应用；停用项保留名称，避免历史任务显示内部模型。 */
export async function loadLensAssetTaskApplications(): Promise<LensModelOption[]> {
  const groups = await Promise.all([getImageModels(), getImage2ImageModels()])
  return [...new Map(groups.flat().map((model) => [String(model.value), model])).values()]
}

/** 仅按原始应用ID解析显示名，不拿内部模型名冒充应用名。 */
export function resolveLensTaskApplicationName(originAppId: string | number | undefined, models: readonly LensModelOption[]): string {
  const id = originAppId === undefined ? '' : String(originAppId).trim()
  if (!id) return '应用ID缺失'
  const name = models.find((model) => String(model.value) === id)?.label?.trim()
  return name || '未匹配应用（' + id + '）'
}
