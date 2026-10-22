/**
 * Lens 画布资产库管理弹窗
 *
 * <p>与「从资产库选择参考」同源样式，但用途不同：
 * <ol>
 *   <li><b>管理模式</b>（画布分镜组右侧「资产库」按钮）：可新增角色/场景/道具，
 *       主资产可新增子造型/子场景，新增后刷新当前 Tab；</li>
 *   <li><b>选择模式</b>（画布空白处右键「添加资产」）：标题改为「从资产库添加」，
 *       点击资产直接回调给画布生成资产图节点，不显示任何新增入口。</li>
 * </ol>
 *
 * <p>新增走 Lens 现有业务接口（/api/lensRole、/api/lensImage/upload），
 * 与归一前端 RoleManagerPage / SceneVariantEditDrawer 同契约，不自建平行接口。
 */
import React from 'react'
import { Button, Group, Loader, Modal, Tabs, Text, TextInput } from '@mantine/core'
import { IconPlus, IconRefresh } from '@tabler/icons-react'
import {
  createAssetImage,
  createRole,
  createRoleClone,
  createSubScene,
  listReferenceAssets,
  type LensAssetImage,
  type LensRole,
} from '../api/lens'
import { groupReferenceAssets, ReferenceCategory, type ReferenceAsset, type ReferenceGroup } from '../canvas/nodes/lensShotReferences'
import '../canvas/components/lensReferencePicker.css'
import { toast } from '../ui/toast'

/** Tab 定义：与 ReferenceCategory 一一对应，顺序即展示顺序。 */
const TABS = [
  { value: ReferenceCategory.Role, label: '角色' },
  { value: ReferenceCategory.Scene, label: '场景' },
  { value: ReferenceCategory.Prop, label: '道具' },
]

/** 新增弹窗的上下文：决定调哪个接口。 */
interface AddContext {
  /** 资产分类 */
  category: ReferenceCategory
  /** 父级ID：角色=主角色ID，场景=主场景ID；为空表示新增主资产 */
  parentId?: string
  /** 父级名称：子造型/子场景需要继承父级名称 */
  parentName?: string
}

interface Props {
  /** 是否打开 */
  opened: boolean
  /** 剧ID */
  dramaId: string
  /** 关闭回调 */
  onClose: () => void
  /** 选择资产回调；传入即为选择模式（右键「添加资产」） */
  onSelectAsset?: (asset: ReferenceAsset) => void
}

/**
 * 判断某分类下的资产是否支持子级：角色支持子造型、场景支持子场景，道具没有层级。
 *
 * @param category 资产分类
 * @returns true 表示可在主资产上新增子级
 */
function supportsChildren(category: ReferenceCategory): boolean {
  return category === ReferenceCategory.Role || category === ReferenceCategory.Scene
}

/**
 * 生成子级按钮与写法的统一文案。
 *
 * <p>角色与场景的子级在 UI 上统一叫「子造型」之外的名字容易混淆，
 * 这里按分类返回专属文案，避免在 JSX 各处写三元表达式。
 *
 * @param category 资产分类
 * @returns 子级名称（角色=子造型，场景=子场景）
 */
function childLabel(category: ReferenceCategory): string {
  return category === ReferenceCategory.Role ? '子造型' : '子场景'
}

/**
 * Lens 画布资产库管理弹窗
 *
 * @param props 组件参数
 * @returns 弹窗节点
 */
export function AssetLibraryModal({ opened, dramaId, onClose, onSelectAsset }: Props): JSX.Element {
  const [tab, setTab] = React.useState<ReferenceCategory>(ReferenceCategory.Role)
  const [groups, setGroups] = React.useState<ReferenceGroup[]>([])
  const [keyword, setKeyword] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [reload, setReload] = React.useState(0)
  /** 新增弹窗上下文；null 表示关闭 */
  const [addContext, setAddContext] = React.useState<AddContext | null>(null)
  const [addingName, setAddingName] = React.useState('')

  const isSelectMode = Boolean(onSelectAsset)

  // 打开时重置：切剧或重复打开都不应残留上一次的 Tab / 搜索词 / 弹窗状态
  React.useEffect(() => {
    if (!opened) return
    setKeyword('')
    setTab(ReferenceCategory.Role)
    setAddContext(null)
    setAddingName('')
  }, [opened, dramaId])

  // 拉取当前 Tab 的资产（含子级）；新增成功后由 reload 递增触发重新拉取
  React.useEffect(() => {
    if (!opened) return
    let active = true
    setLoading(true)
    setError('')
    setGroups([])
    if (!dramaId) {
      setError('缺少剧集身份，无法加载资产')
      setLoading(false)
      return
    }
    void listReferenceAssets<LensRole & LensAssetImage>(dramaId, tab)
      .then((rows) => { if (active) setGroups(groupReferenceAssets(tab, rows)) })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '资产加载失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [opened, dramaId, tab, reload])

  const visibleGroups = groups.filter((group) =>
    (group.name + group.items.map((item) => item.variantName || item.name).join(' ')).toLowerCase().includes(keyword.trim().toLowerCase())
  )

  /** 打开新增弹窗；不传 parentId 表示新增主资产 */
  const openAdd = (category: ReferenceCategory, parentId?: string, parentName?: string) => {
    setAddContext({ category, parentId, parentName })
    setAddingName('')
  }

  /** 关闭新增弹窗 */
  const closeAdd = () => {
    setAddContext(null)
    setAddingName('')
  }

  /**
   * 提交新增资产：按上下文选择接口，成功后关闭弹窗并刷新当前 Tab。
   *
   * <p>失败时保留弹窗与输入内容，方便用户改名重试；错误按后端原样提示。
   */
  const submitAdd = async () => {
    if (!addContext || saving) return
    const name = addingName.trim()
    if (!name) {
      toast('请输入名称')
      return
    }
    setSaving(true)
    try {
      if (addContext.category === ReferenceCategory.Role) {
        if (addContext.parentId) {
          await createRoleClone(dramaId, addContext.parentId, addContext.parentName || '', name)
        } else {
          await createRole(dramaId, name)
        }
      } else if (addContext.category === ReferenceCategory.Scene) {
        if (addContext.parentId) {
          await createSubScene(dramaId, addContext.parentId, addContext.parentName || '', name)
        } else {
          await createAssetImage(dramaId, 1, name)
        }
      } else {
        await createAssetImage(dramaId, 2, name)
      }
      toast(`已新增${addDialogTitle}`)
      closeAdd()
      setReload((value) => value + 1)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '保存失败'
      toast(message)
    } finally {
      setSaving(false)
    }
  }

  /** 选择模式下点击资产：交给画布生成资产图节点 */
  const handleSelectAsset = (asset: ReferenceAsset) => {
    if (!onSelectAsset) return
    onSelectAsset(asset)
    onClose()
  }

  /** 新增弹窗标题：主资产显示分类名，子级显示「添加子造型 / 添加子场景」 */
  const addDialogTitle = addContext?.parentId
    ? `添加${childLabel(addContext.category)}`
    : `添加${TABS.find((item) => item.value === addContext?.category)?.label || '资产'}`

  /** 渲染单张资产卡片（选择模式可点击；子级显示角标；主资产显示 +子级按钮） */
  const renderCard = (asset: ReferenceAsset, groupName: string) => {
    // 取一次收窄后的地址，既避免非空断言，也保证缩略图沿用画布统一的 OSS 缩放口径
    const imgUrl = asset.imgUrl || ''
    const clickable = isSelectMode
    return (
      <article
        className="lens-reference-picker__card"
        key={asset.category + ':' + asset.id}
        onClick={() => { if (clickable) handleSelectAsset(asset) }}
        style={{ cursor: clickable ? 'pointer' : 'default' }}
      >
        <div className={'lens-reference-picker__thumb' + (asset.category === ReferenceCategory.Role ? ' lens-reference-picker__thumb--role' : '')}>
          {imgUrl
            ? <img className="lens-reference-picker__image" src={`${imgUrl}${imgUrl.includes('?') ? '&' : '?'}x-oss-process=image/resize,w_200`} alt={asset.variantName || asset.name} loading="lazy" />
            : <Text className="lens-reference-picker__no-image" size="xs">暂无图片</Text>}
          {asset.parentId && <span className="lens-reference-picker__badge">{childLabel(asset.category)}</span>}
        </div>
        <Text className="lens-reference-picker__label" size="xs" title={asset.name}>
          {asset.parentId ? asset.variantName || childLabel(asset.category) : groupName}
        </Text>
      </article>
    )
  }

  return (
    <>
      <Modal
        className="lens-reference-picker nodrag nopan nowheel"
        opened={opened}
        onClose={onClose}
        title={isSelectMode ? '从资产库添加' : '资产库'}
        centered
        size="min(1100px, 94vw)"
        zIndex={4000}
      >
        <Tabs
          className="lens-reference-picker__tabs"
          value={String(tab)}
          onChange={(value) => { if (value) { setTab(Number(value) as ReferenceCategory); setKeyword('') } }}
        >
          <Tabs.List className="lens-reference-picker__tab-list">
            {TABS.map((item) => (
              <Tabs.Tab className="lens-reference-picker__tab" key={item.value} value={String(item.value)}>{item.label}</Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>

        <Group gap="xs" wrap="nowrap">
          <TextInput
            className="lens-reference-picker__search"
            aria-label="搜索资产"
            placeholder={`搜索${TABS.find((item) => item.value === tab)?.label || '资产'}名称或${childLabel(tab)}`}
            value={keyword}
            onChange={(event) => setKeyword(event.currentTarget.value)}
            style={{ flex: 1 }}
          />
          {/* 手动刷新：新增/别处修改后立即拉取最新列表 */}
          <Button
            className="lens-reference-picker__retry"
            variant="subtle"
            size="compact-sm"
            loading={loading}
            leftSection={<IconRefresh size={14} />}
            onClick={() => setReload((value) => value + 1)}
          >
            刷新
          </Button>
        </Group>

        {error && (
          <Group className="lens-reference-picker__error" gap="xs">
            <Text className="lens-reference-picker__error-text" c="red" role="alert" size="sm">{error}</Text>
          </Group>
        )}

        <div className="lens-reference-picker__body">
          {loading && <Loader className="lens-reference-picker__loader" size="sm" />}
          {!loading && !error && !visibleGroups.length && (
            <Text className="lens-reference-picker__empty" size="sm">
              {keyword ? '暂无匹配资产' : `暂无${TABS.find((item) => item.value === tab)?.label || '资产'}，可点击左侧「添加」新建`}
            </Text>
          )}
          <div
            className={'lens-reference-picker__groups' + (!isSelectMode ? ' lens-reference-picker__groups--manage' : '')}
          >
            {/* 道具没有父子层级与分组标题：全部卡片（含「添加」入口）放在同一个分组、
                同一条 flex 卡片流里，与角色/场景的卡片尺寸、间距、图文对齐保持一致。
                「添加」必须是流内第一张卡，而不是单独占一行，否则上方会空出整行。 */}
            {tab === ReferenceCategory.Prop && (
              <section className="lens-reference-picker__group lens-reference-picker__group--flat">
                <div className="lens-reference-picker__items">
                  {!loading && !error && !isSelectMode && (
                    <article className="lens-reference-picker__card lens-reference-picker__card--add" key="add-entry" onClick={() => openAdd(tab)}>
                      <div className="lens-reference-picker__thumb lens-reference-picker__thumb--add">
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                          <IconPlus size={26} />
                          <Text size="sm" fw={600}>添加{TABS.find((item) => item.value === tab)?.label}</Text>
                        </div>
                      </div>
                      {/* 与普通卡片同样的名称行占位，保证入口卡与道具卡等高、上下沿齐平 */}
                      <Text className="lens-reference-picker__label" size="xs">&nbsp;</Text>
                    </article>
                  )}
                  {visibleGroups.flatMap((group) => group.items.map((asset) => renderCard(asset, asset.name)))}
                </div>
              </section>
            )}

            {/* 角色/场景：「添加」为独立分组，固定排在最前 */}
            {tab !== ReferenceCategory.Prop && !loading && !error && !isSelectMode && (
              <section className="lens-reference-picker__group lens-reference-picker__group--add" key="add-entry">
                <div className="lens-reference-picker__items">
                  <article className="lens-reference-picker__card lens-reference-picker__card--add" onClick={() => openAdd(tab)}>
                    <div className={'lens-reference-picker__thumb lens-reference-picker__thumb--add' + (tab === ReferenceCategory.Role ? ' lens-reference-picker__thumb--role' : '')}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        <IconPlus size={26} />
                        <Text size="sm" fw={600}>添加{TABS.find((item) => item.value === tab)?.label}</Text>
                      </div>
                    </div>
                    <Text className="lens-reference-picker__label" size="xs">&nbsp;</Text>
                  </article>
                </div>
              </section>
            )}

            {tab !== ReferenceCategory.Prop && visibleGroups.map((group) => {
              // 子级数量：该组下除主资产外的条目数（后端 variant_count / clone_count 只统计入库数量，
              // 这里按实际列表计算，保证新增后立刻准确）
              const childCount = group.items.filter((item) => Boolean(item.parentId)).length
              return (
                <section
                  className={'lens-reference-picker__group' + (supportsChildren(tab) && !isSelectMode ? ' lens-reference-picker__group--manage' : '')}
                  key={group.id}
                >
                  <Group className="lens-reference-picker__group-header" justify="space-between" wrap="nowrap">
                    {/* 名称后面紧跟数量，如「张三（3个子造型）」 */}
                    <Text className="lens-reference-picker__group-name" size="sm" fw={600}>
                      {group.name}
                      <Text component="span" size="xs" c="dimmed">（{childCount}{childLabel(tab)}）</Text>
                    </Text>
                    {/* 分组标题右侧新增子级入口：仅管理模式显示，道具没有子级（已在上层过滤） */}
                    {!isSelectMode && supportsChildren(tab) && (
                      <Button
                        className="lens-reference-picker__add-child"
                        size="compact-xs"
                        variant="light"
                        leftSection={<IconPlus size={12} />}
                        disabled={saving}
                        onClick={() => openAdd(tab, group.id, group.name)}
                      >
                        {/* 按钮左侧已有 + 图标，文案不再重复「添加」 */}
                        {childLabel(tab)}
                      </Button>
                    )}
                  </Group>
                  <div className="lens-reference-picker__items">
                    {group.items.map((asset) => renderCard(asset, group.name))}
                  </div>
                </section>
              )
            })}
          </div>
        </div>

        <Group className="lens-reference-picker__footer" justify="flex-end">
          <Button className="lens-reference-picker__cancel" variant="default" onClick={onClose}>关闭</Button>
        </Group>
      </Modal>

      {/* 新增资产名称输入弹窗 */}
      <Modal opened={Boolean(addContext)} onClose={closeAdd} title={addDialogTitle} size="sm" zIndex={4100}>
        <TextInput
          label="名称"
          placeholder={addContext?.parentId ? `请输入${childLabel(addContext.category)}名称` : '请输入名称'}
          value={addingName}
          onChange={(event) => setAddingName(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void submitAdd() }}
          data-autofocus
        />
        <Group justify="flex-end" mt="md">
          <Button variant="subtle" onClick={closeAdd} disabled={saving}>取消</Button>
          <Button onClick={() => void submitAdd()} loading={saving}>确定</Button>
        </Group>
      </Modal>
    </>
  )
}

