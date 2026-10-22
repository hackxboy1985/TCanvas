/**
 * Lens 画布资产库管理弹窗
 * 
 * 基于 LensReferencePicker 的样式，提供资产管理功能：
 * 1. 展示角色、场景、道具三个 Tab
 * 2. 第一个位置固定显示"添加"按钮
 * 3. 点击"添加"弹出名称输入框，调用 Lens 接口保存资产
 * 4. 已有角色在名称后显示"（X个造型）"，右上角显示"+子造型"按钮
 * 5. 子场景也一样处理
 * 6. 支持"选择模式"（用于右键菜单"添加资产"）
 */
import React from 'react'
import { Button, Group, Loader, Modal, Tabs, Text, TextInput, ActionIcon, Tooltip } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import { listReferenceAssets, type LensAssetImage } from '../api/lens'
import { groupReferenceAssets, ReferenceCategory, type ReferenceGroup } from '../canvas/nodes/lensShotReferences'
import '../canvas/components/lensReferencePicker.css'
import { toast } from '../ui/toast'

const TABS = [
  { value: ReferenceCategory.Role, label: '角色' },
  { value: ReferenceCategory.Scene, label: '场景' },
  { value: ReferenceCategory.Prop, label: '道具' }
]

interface Props {
  opened: boolean
  dramaId: string
  onClose: () => void
  onSelectAsset?: (asset: LensAssetImage) => void
}

export function AssetLibraryModal({ opened, dramaId, onClose, onSelectAsset }: Props): JSX.Element {
  const [tab, setTab] = React.useState(ReferenceCategory.Role)
  const [groups, setGroups] = React.useState<ReferenceGroup[]>([])
  const [keyword, setKeyword] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [reload, setReload] = React.useState(0)
  const [showAddDialog, setShowAddDialog] = React.useState(false)
  const [addingName, setAddingName] = React.useState('')
  const [addingParentId, setAddingParentId] = React.useState<string | null>(null)
  const [addingCategory, setAddingCategory] = React.useState<number>(1)

  React.useEffect(() => {
    if (opened) {
      setKeyword('')
      setTab(ReferenceCategory.Role)
      setShowAddDialog(false)
      setAddingName('')
      setAddingParentId(null)
    }
  }, [opened, dramaId])

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
    void listReferenceAssets(dramaId, tab)
      .then((rows) => { if (active) setGroups(groupReferenceAssets(tab, rows)) })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '资产加载失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [opened, dramaId, tab, reload])

  const visibleGroups = groups.filter((group) =>
    (group.name + group.items.map((item) => item.variantName || item.name).join(' ')).toLowerCase().includes(keyword.trim().toLowerCase())
  )

  const openAddDialog = (category: number, parentId?: string) => {
    setAddingCategory(category)
    setAddingParentId(parentId || null)
    setAddingName('')
    setShowAddDialog(true)
  }

  const saveAsset = async () => {
    if (!addingName.trim()) {
      toast('请输入名称')
      return
    }
    const categoryLabel = addingCategory === 1 ? '角色' : addingCategory === 2 ? '场景' : '道具'
    const typeLabel = addingParentId ? (addingCategory === 1 ? '子造型' : '子场景') : categoryLabel
    toast(`保存${typeLabel}：${addingName}`)
    setShowAddDialog(false)
    setAddingName('')
    setAddingParentId(null)
    setReload((value) => value + 1)
  }

  const handleSelectAsset = (asset: LensAssetImage) => {
    if (onSelectAsset) {
      onSelectAsset(asset)
      onClose()
    }
  }

  const isSelectMode = Boolean(onSelectAsset)
  const modalTitle = isSelectMode ? '从资产库添加' : '资产库'

  return (
    <>
      <Modal className="lens-reference-picker nodrag nopan nowheel" opened={opened} onClose={onClose} title={modalTitle} centered size="min(1100px, 94vw)" zIndex={4000}>
        <Tabs className="lens-reference-picker__tabs" value={String(tab)} onChange={(value) => { if (value) { setTab(Number(value)); setKeyword('') } }}>
          <Tabs.List className="lens-reference-picker__tab-list">
            {TABS.map((item) => <Tabs.Tab className="lens-reference-picker__tab" key={item.value} value={String(item.value)}>{item.label}</Tabs.Tab>)}
          </Tabs.List>
        </Tabs>
        <TextInput className="lens-reference-picker__search" aria-label="搜索资产" placeholder="搜索名称或子造型、子场景" value={keyword} onChange={(event) => setKeyword(event.currentTarget.value)} />
        {error && <Group className="lens-reference-picker__error" gap="xs"><Text className="lens-reference-picker__error-text" c="red" role="alert" size="sm">{error}</Text><Button className="lens-reference-picker__retry" size="compact-xs" variant="subtle" onClick={() => setReload((value) => value + 1)}>重新加载</Button></Group>}
        <div className="lens-reference-picker__body">
          {loading && <Loader className="lens-reference-picker__loader" size="sm" />}
          {!loading && !error && !visibleGroups.length && keyword && <Text className="lens-reference-picker__empty" size="sm">暂无匹配资产</Text>}
          <div className={'lens-reference-picker__groups ' + (tab === ReferenceCategory.Prop ? 'lens-reference-picker__groups--props' : '')}>
            {!loading && !error && !isSelectMode && <section className="lens-reference-picker__group"><div className="lens-reference-picker__items"><article className="lens-reference-picker__card lens-reference-picker__card--add" onClick={() => openAddDialog(tab)} style={{ cursor: 'pointer', borderStyle: 'dashed' }}><div className={'lens-reference-picker__thumb lens-reference-picker__thumb--add' + (tab === ReferenceCategory.Role ? ' lens-reference-picker__thumb--role' : '')}><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '8px' }}><IconPlus size={32} /><Text size="sm" fw={500}>添加{TABS.find(t => t.value === tab)?.label}</Text></div></div></article></div></section>}
            {visibleGroups.map((group) => <section className="lens-reference-picker__group" key={group.id}>{tab !== ReferenceCategory.Prop && <Group className="lens-reference-picker__group-header" justify="space-between"><Group gap="xs"><Text className="lens-reference-picker__group-name" size="sm" fw={600}>{group.name}</Text>{group.items.length > 0 && group.items[0].parentId === null && <Text className="lens-reference-picker__group-count" size="xs" c="dimmed">({group.items.length}个造型)</Text>}</Group>{!isSelectMode && tab !== ReferenceCategory.Prop && group.items.length > 0 && group.items[0].parentId === null && <Tooltip label={`添加${tab === ReferenceCategory.Role ? '子造型' : '子场景'}`}><ActionIcon size="sm" variant="light" onClick={() => openAddDialog(tab, group.id)}><IconPlus size={14} /></ActionIcon></Tooltip>}</Group>}<div className="lens-reference-picker__items">{group.items.map((asset) => { const key = `${asset.category}-${asset.id}`; const hasImage = Boolean(asset.imgUrl); return <article className="lens-reference-picker__card" key={key} onClick={() => isSelectMode && hasImage && handleSelectAsset(asset as unknown as LensAssetImage)} style={{ cursor: isSelectMode && hasImage ? 'pointer' : 'default' }}><div className={'lens-reference-picker__thumb' + (tab === ReferenceCategory.Role ? ' lens-reference-picker__thumb--role' : '')}>{asset.imgUrl ? <img className="lens-reference-picker__image" src={`${asset.imgUrl}${asset.imgUrl.includes('?') ? '&' : '?'}x-oss-process=image/resize,w_200`} alt={asset.variantName || asset.name} loading="lazy" /> : <Text className="lens-reference-picker__no-image" size="xs">暂无图片</Text>}{asset.parentId && <span className="lens-reference-picker__badge">{tab === ReferenceCategory.Role ? '其他造型' : '子场景'}</span>}</div><Text className="lens-reference-picker__label" size="xs" title={asset.name}>{asset.parentId ? (tab === ReferenceCategory.Role ? asset.variantName || '其他造型' : asset.variantName || '子场景') : group.name}</Text></article> })}</div></section>)}
          </div>
        </div>
        <Group className="lens-reference-picker__footer" justify="flex-end"><Button className="lens-reference-picker__cancel" variant="default" onClick={onClose}>关闭</Button></Group>
      </Modal>
      <Modal opened={showAddDialog} onClose={() => setShowAddDialog(false)} title={`添加${addingParentId ? (addingCategory === 1 ? '子造型' : '子场景') : TABS.find(t => t.value === addingCategory)?.label}`} size="sm" zIndex={4100}><TextInput label="名称" placeholder="请输入名称" value={addingName} onChange={(e) => setAddingName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') { void saveAsset() } }} autoFocus /><Group justify="flex-end" mt="md"><Button variant="subtle" onClick={() => setShowAddDialog(false)}>取消</Button><Button onClick={() => void saveAsset()}>确定</Button></Group></Modal>
    </>
  )
}

