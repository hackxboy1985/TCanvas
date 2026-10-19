import React from 'react'
import { Button, Group, Loader, Modal, Tabs, Text, TextInput } from '@mantine/core'
import { listReferenceAssets } from '../../api/lens'
import { groupReferenceAssets, ReferenceCategory, referenceKey, type ReferenceAsset, type ReferenceGroup } from '../nodes/lensShotReferences'
import './lensReferencePicker.css'

const SCENE_SUBTYPE_LABELS: Record<string, string> = { time: '日夜', weather: '天气', inout: '内外', area: '区域', position: '位置', furniture: '家具', facility: '设施' }
const TABS = [{ value: ReferenceCategory.Role, label: '角色' }, { value: ReferenceCategory.Scene, label: '场景' }, { value: ReferenceCategory.Prop, label: '道具' }]
interface Props { opened: boolean; dramaId: string; existingKeys: string[]; onClose: () => void; onConfirm: (assets: ReferenceAsset[]) => Promise<void> }
/** 与分镜板同构的资产列表，保留父子分组、批量选择与直接添加。 */
export function LensReferencePicker({ opened, dramaId, existingKeys, onClose, onConfirm }: Props): JSX.Element {
  const [tab, setTab] = React.useState(ReferenceCategory.Role)
  const [groups, setGroups] = React.useState<ReferenceGroup[]>([])
  const [picked, setPicked] = React.useState<Record<string, ReferenceAsset>>({})
  const [keyword, setKeyword] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [reload, setReload] = React.useState(0)
  const savingRef = React.useRef(false)
  React.useEffect(() => { if (opened) { setPicked({}); setKeyword(''); setTab(ReferenceCategory.Role) } }, [opened, dramaId])
  React.useEffect(() => {
    if (!opened) return
    let active = true
    setLoading(true); setError(''); setGroups([])
    if (!dramaId) { setError('缺少剧集身份，无法加载资产'); setLoading(false); return }
    void listReferenceAssets(dramaId, tab).then((rows) => { if (active) setGroups(groupReferenceAssets(tab, rows)) })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '资产加载失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [opened, dramaId, tab, reload])
  const selected = Object.values(picked)
  const existing = new Set(existingKeys)
  const visibleGroups = groups.filter((group) => (group.name + group.items.map((item) => item.variantName || item.name).join(' ')).toLowerCase().includes(keyword.trim().toLowerCase()))
  /** 保存失败保留勾选与弹窗，防止重复点击并允许重试。 */
  const confirm = async (assets: ReferenceAsset[]) => {
    if (savingRef.current || !assets.length) return
    savingRef.current = true; setSaving(true); setError('')
    try { await onConfirm(assets); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '参考保存失败') }
    finally { savingRef.current = false; setSaving(false) }
  }
  return <Modal className="lens-reference-picker nodrag nopan nowheel" opened={opened} onClose={() => { if (!saving) onClose() }} title="从资产库选择参考" centered size="min(1100px, 94vw)" zIndex={4000} closeOnClickOutside={!saving} closeOnEscape={!saving}>
    <Tabs className="lens-reference-picker__tabs" value={String(tab)} onChange={(value) => { if (value && !saving) { setTab(Number(value)); setKeyword('') } }}>
      <Tabs.List className="lens-reference-picker__tab-list">{TABS.map((item) => <Tabs.Tab className="lens-reference-picker__tab" key={item.value} value={String(item.value)}>{item.label}</Tabs.Tab>)}</Tabs.List>
    </Tabs>
    <TextInput className="lens-reference-picker__search" aria-label="搜索资产" placeholder="搜索名称或子造型、子场景" value={keyword} onChange={(event) => setKeyword(event.currentTarget.value)} disabled={saving} />
    {error && <Group className="lens-reference-picker__error" gap="xs"><Text className="lens-reference-picker__error-text" c="red" role="alert" size="sm">{error}</Text><Button className="lens-reference-picker__retry" size="compact-xs" variant="subtle" disabled={saving} onClick={() => setReload((value) => value + 1)}>重新加载</Button></Group>}
    <div className="lens-reference-picker__body">
      {loading && <Loader className="lens-reference-picker__loader" size="sm" />}
      {!loading && !error && !visibleGroups.length && <Text className="lens-reference-picker__empty" size="sm">暂无匹配资产</Text>}
      <div className={'lens-reference-picker__groups ' + (tab === ReferenceCategory.Prop ? 'lens-reference-picker__groups--props' : '')}>
        {visibleGroups.map((group) => <section className="lens-reference-picker__group" key={group.id}>
          {tab !== ReferenceCategory.Prop && <Group className="lens-reference-picker__group-header" justify="space-between"><Text className="lens-reference-picker__group-name" size="sm" fw={600}>{group.name}</Text><Text className="lens-reference-picker__group-count" size="xs">{group.items.length}个{tab === ReferenceCategory.Role ? '造型' : '场景'}</Text></Group>}
          <div className="lens-reference-picker__items">{group.items.map((asset) => {
            const key = referenceKey(asset)
            const linked = existing.has(key)
            const checked = linked || Boolean(picked[key])
            const disabled = linked || saving || !asset.imgUrl
            const toggle = () => setPicked((previous) => { const next = { ...previous }; if (next[key]) delete next[key]; else next[key] = asset; return next })
            return <article className={'lens-reference-picker__card' + (checked ? ' is-selected' : '')} key={key}>
              <div className={'lens-reference-picker__thumb' + (tab === ReferenceCategory.Role ? ' lens-reference-picker__thumb--role' : '')}>
                {asset.imgUrl ? <img className="lens-reference-picker__image" src={asset.imgUrl} alt={asset.variantName || asset.name} loading="lazy" /> : <Text className="lens-reference-picker__no-image" size="xs">暂无图片</Text>}
                {asset.parentId && <span className="lens-reference-picker__badge">{tab === ReferenceCategory.Role ? '其他造型' : asset.variantName || '子场景'}{asset.subType && SCENE_SUBTYPE_LABELS[asset.subType] ? ' · ' + SCENE_SUBTYPE_LABELS[asset.subType] : ''}</span>}
                {checked && <span className="lens-reference-picker__check">{linked ? '已关联' : '✓'}</span>}
                <div className="lens-reference-picker__hover">
                  <button className="lens-reference-picker__action" type="button" disabled={disabled} onClick={() => { void confirm([asset]) }}>直接添加</button>
                  <button className="lens-reference-picker__action" type="button" disabled={disabled} aria-pressed={checked} onClick={toggle}>{checked ? '取消' : '选择'}</button>
                </div>
              </div>
              <Text className="lens-reference-picker__label" size="xs" title={asset.name}>{tab === ReferenceCategory.Role && asset.parentId ? asset.variantName || '其他造型' : group.name}</Text>
            </article>
          })}</div>
        </section>)}
      </div>
    </div>
    <Group className="lens-reference-picker__footer" justify="space-between"><Text className="lens-reference-picker__selection-count" size="sm">已选 {selected.length} 项</Text><Group className="lens-reference-picker__buttons"><Button className="lens-reference-picker__cancel" variant="default" disabled={saving} onClick={onClose}>取消</Button><Button className="lens-reference-picker__confirm" loading={saving} disabled={!selected.length} onClick={() => { void confirm(selected) }}>确定添加</Button></Group></Group>
  </Modal>
}
