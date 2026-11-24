import React from 'react'
import { ActionIcon, Badge, Text, TextInput } from '@mantine/core'
import type { IconProps } from '@tabler/icons-react'
import { IconBrush } from '@tabler/icons-react'
import { $ } from '../../../i18n'

type TaskNodeHeaderProps = {
  NodeIcon: React.ComponentType<IconProps>
  editing: boolean
  labelDraft: string
  currentLabel: string
  subtitle: string
  statusLabel?: string | null
  statusColor: string
  nodeShellText: string
  iconBadgeBackground: string
  iconBadgeShadow: string
  sleekChipBase: React.CSSProperties
  labelSingleLine?: boolean
  showMeta?: boolean
  showIcon?: boolean
  showStatus?: boolean
  showSubtitle?: boolean
  /** 第二行彩色类型角标（图片节点区分角色/场景/道具/衍生/自由）；传入后替代副标题文字 */
  subtitleBadge?: {
    label: string
    color: string
    background: string
    borderColor: string
    /** 角标文字色，与背景拉开对比度；不传时退回 color */
    textColor?: string
  } | null
  /** 标题栏左侧强调色条（图片节点类别色）；不传则不渲染 */
  accentColor?: string
  /** 标题右侧的业务操作，不依赖节点是否已有生成结果。 */
  actions?: React.ReactNode
  isNew?: boolean
  metaBadges?: Array<{
    label: string
    color: string
    variant?: 'light' | 'outline' | 'filled'
  }>
  onLabelDraftChange: (value: string) => void
  onCommitLabel: () => void
  onCancelEdit: () => void
  onStartEdit: () => void
  labelInputRef: React.Ref<HTMLInputElement>
  /** 画布缩放补偿系数：>1 时反向放大标题栏，保证标题在屏幕上尺寸不随缩放变小 */
  scale?: number
  /** 画布当前缩放值：用于二级标题渐隐（<0.5 开始半透明，0.2 完全隐藏） */
  zoom?: number
}

/**
 * 标题栏缩放补偿容器。
 *
 * <p>画布缩放会给整个节点套一层 scale，标题文字在缩小时会变小到看不清。
 * 这里对标题栏反向缩放（1/zoom），并把容器高度同步放大，避免视觉上盖住节点内容。</p>
 */
function HeaderScaleBox({ scale, children }: { scale: number; children: React.ReactNode }) {
  if (scale <= 1) return <>{children}</>
  // 用 CSS zoom 做反向补偿：zoom 会同时缩放「布局盒」，高度/宽度按真实排版变化，
  // 不需要每帧测量+setState（之前用 transform + 手量高度会导致缩放到临界档时抖动）
  return (
    <div
      className="task-node-header-scale-box"
      style={{
        zoom: scale,
        width: `${100 / scale}%`,
        position: 'relative',
        zIndex: 41,
      }}
    >
      {children}
    </div>
  )
}

export function TaskNodeHeader({
  NodeIcon,
  editing,
  labelDraft,
  currentLabel,
  subtitle,
  statusLabel,
  statusColor,
  nodeShellText,
  iconBadgeBackground,
  iconBadgeShadow,
  sleekChipBase,
  labelSingleLine,
  showMeta = true,
  showIcon = true,
  showStatus = true,
  showSubtitle = false,
  subtitleBadge,
  accentColor,
  actions,
  isNew = false,
  metaBadges = [],
  onLabelDraftChange,
  onCommitLabel,
  onCancelEdit,
  onStartEdit,
  labelInputRef,
  scale = 1,
  zoom = 1,
}: TaskNodeHeaderProps) {
  // 二级标题渐隐：zoom>=0.5 全显示，0.2<=zoom<0.5 线性半透明，zoom<=0.2 完全隐藏（不再占位）
  const subtitleOpacity = zoom >= 0.5 ? 1 : zoom <= 0.2 ? 0 : (zoom - 0.2) / 0.3
  const hideSubtitle = subtitleOpacity <= 0
  // 画布缩小时标题栏被反向放大，节点在屏幕上变窄：隐藏图标/操作/状态等非文字元素，把宽度让给标题，
  // 否则固定尺寸的图标会挤得标题只剩"陈…"这种省略；一级/二级标题必须始终保留
  const zoomCompacted = scale > 1
  if (!showMeta) {
    return (
      <HeaderScaleBox scale={scale}>
      <div
        className="task-node-header task-node-header--compact"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
          // 生成中遮罩（inset:0 + backdrop-blur）会盖住整个节点，标题必须叠在遮罩之上才不被糊住
          position: 'relative',
          zIndex: 41,
          // 类别色条：让图片节点在画布缩放较小、标题被截断时也能靠颜色区分。
          // 标题栏做了反向缩放补偿，这里的 8px 在屏幕上恒定是 8px（不会随画布缩放变窄），
          // 因此缩放前后色条与标题的空隙保持一致
          ...(accentColor ? { borderLeft: `3px solid ${accentColor}`, paddingLeft: 8 } : null),
        }}
      >
        {showIcon && !zoomCompacted && (
          <div
            className="task-node-header-icon"
            style={{
              width: 40,
              height: 40,
              borderRadius: 14,
              background: iconBadgeBackground,
              boxShadow: iconBadgeShadow,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: '#fff',
            }}
            title={currentLabel}
          >
            <NodeIcon className="task-node-header-icon-svg" size={18} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text
            className="task-node-header-compact-title"
            size="sm"
            fw={600}
            style={{
              color: nodeShellText,
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
              // 缩放补偿时节点在屏幕上很窄：允许标题溢出卡片显示完整文字，不再出现"陈…"
              ...(zoomCompacted ? { overflow: 'visible', textOverflow: 'clip' } : null),
            }}
            title={currentLabel}
          >
            {currentLabel}
          </Text>
          {showSubtitle && (subtitleBadge ? (
            <span
              className="task-node-header-subtitle-badge"
              title={subtitleBadge.label}
              style={{
                opacity: subtitleOpacity,
                // 缩到 0.2 用 max-height 平滑收起：直接卸载会让标题区高度瞬间塌陷，看起来"抖一下"
                maxHeight: hideSubtitle ? 0 : 40,
                overflow: 'hidden',
                transition: 'opacity 120ms ease, max-height 160ms ease',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                maxWidth: '100%',
                height: 19,
                marginTop: 4,
                padding: '0 8px',
                borderRadius: 6,
                border: `1px solid ${subtitleBadge.borderColor}`,
                background: subtitleBadge.background,
                color: subtitleBadge.textColor ?? subtitleBadge.color,
                fontSize: 11,
                fontWeight: 500,
                lineHeight: '17px',
                letterSpacing: 0.4,
                whiteSpace: 'nowrap',
                overflow: 'visible',
                flexShrink: 0,
                // 顶部 1px 内高光 + 轻微下沉投影，形成玻璃质感（Raycast 方案核心细节）
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.35)',
              }}
            >
              {subtitleBadge.label}
            </span>
          ) : subtitle.trim() ? (
            <Text
              className="task-node-header-compact-subtitle"
              size="xs"
              style={{
                color: 'rgba(127,127,127,0.85)',
                fontSize: 11,
                lineHeight: 1.2,
                marginTop: 1,
                opacity: subtitleOpacity,
                maxHeight: hideSubtitle ? 0 : 40,
                overflow: 'hidden',
                transition: 'opacity 120ms ease, max-height 160ms ease',
              }}
            >
              {subtitle}
            </Text>
          ) : null)}
        </div>
        {!zoomCompacted && actions}
        {isNew && (
          <Badge className="task-node-header-new-badge" size="xs" radius="md" color="pink" variant="light">
            {$('新建')}
          </Badge>
        )}
      </div>
      </HeaderScaleBox>
    )
  }

  return (
    <HeaderScaleBox scale={scale}>
    <div
      className="task-node-header"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        marginBottom: 12,
        cursor: 'grab',
        // 同上：标题栏压在生成中遮罩之上，避免一级/二级标题被模糊遮挡
        position: 'relative',
        zIndex: 41,
      }}
    >
      <div className="task-node-header-main" style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
        {showIcon && !zoomCompacted && (
          <div
            className="task-node-header-icon"
            style={{
              width: 40,
              height: 40,
              borderRadius: 14,
              background: iconBadgeBackground,
              boxShadow: iconBadgeShadow,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: '#fff',
            }}
          >
            <NodeIcon className="task-node-header-icon-svg" size={18} />
          </div>
        )}
        <div className="task-node-header-content" style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <TextInput
              className="task-node-header-input"
              ref={labelInputRef}
              size="xs"
              value={labelDraft}
              onChange={(e) => onLabelDraftChange(e.currentTarget.value)}
              onBlur={onCommitLabel}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  onCommitLabel()
                } else if (e.key === 'Escape') {
                  onCancelEdit()
                }
              }}
            />
          ) : (
            <>
              <div className="task-node-header-title-row" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Text
                  className="task-node-header-title"
                  size="sm"
                  fw={600}
                  style={{
                    color: nodeShellText,
                    lineHeight: 1.2,
                    cursor: 'pointer',
                    flex: 1,
                    ...(labelSingleLine
                      ? {
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }
                      : {}),
                  }}
                  title={$("双击重命名")}
                  onDoubleClick={onStartEdit}
                >
                  {currentLabel}
                </Text>
                {isNew && (
                  <Badge className="task-node-header-new-badge" size="xs" radius="md" color="pink" variant="light">
                    {$('新建')}
                  </Badge>
                )}
                {!zoomCompacted && (<ActionIcon className="task-node-header-rename" size="sm" variant="subtle" color="gray" title={$("重命名")} onClick={onStartEdit}>
                  <IconBrush className="task-node-header-rename-icon" size={12} />
                </ActionIcon>)}
              </div>
              <Text
                className="task-node-header-subtitle"
                size="xs"
                c="dimmed"
                style={{
                  marginTop: 2,
                  opacity: subtitleOpacity,
                  maxHeight: hideSubtitle ? 0 : 40,
                  overflow: 'hidden',
                  transition: 'opacity 120ms ease, max-height 160ms ease',
                }}
              >
                {subtitle}
              </Text>
              {!zoomCompacted && metaBadges.length > 0 && (
                <div
                  className="task-node-header-meta-badges"
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}
                >
                  {metaBadges.map((badge) => (
                    <Badge
                      key={`${badge.label}-${badge.color}`}
                      className="task-node-header-meta-badge"
                      size="xs"
                      radius="md"
                      color={badge.color}
                      variant={badge.variant || 'light'}
                    >
                      {badge.label}
                    </Badge>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {showStatus && !zoomCompacted && statusLabel?.trim() && (
        <div
          className="task-node-header-status"
          style={{
            ...sleekChipBase,
            color: statusColor,
            fontSize: 12,
          }}
        >
          <span className="task-node-header-status-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
          <span className="task-node-header-status-text">{statusLabel}</span>
        </div>
      )}
    </div>
    </HeaderScaleBox>
  )
}
