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
function HeaderScaleBox({
  scale,
  variant,
  zoom,
  cornerSubtitle,
  cornerActions,
  children,
}: {
  scale: number
  /** 超低缩放时的名牌形态：floating=0.2~0.5，mini=<0.2 */
  variant: 'inline' | 'floating' | 'mini'
  /** 画布缩放值：用于角落按钮的隐藏阈值 */
  zoom: number
  /** 名牌模式下贴在卡片左上角的二级标题（角标或文字） */
  cornerSubtitle?: React.ReactNode
  /** 名牌模式下固定在卡片右上角的业务按钮 */
  cornerActions?: React.ReactNode
  children: React.ReactNode
}) {
  // 统一胶囊叠层：放大时 headerScale=1，胶囊随画布等比放大，不做反向补偿
  // 用 CSS zoom 做反向补偿：zoom 会同时缩放「布局盒」，高度/宽度按真实排版变化，
  // 不需要每帧测量+setState（之前用 transform + 手量高度会导致缩放到临界档时抖动）。
  // 超低缩放时切换为节点上方的「浮动名牌」：标题不再压住卡片/图片，视觉上更像画布标签
  {
    const isMini = variant === 'mini'
    return (
      // 标题/按钮合并为同一层绝对叠层：不参与卡片布局，缩放时卡片不上下跳；
      // 左边距/右边距用 1/scale 补偿，屏幕位置恒定，不会左右漂移
      <div
        className="task-node-header-scale-box task-node-header-scale-box--overlay"
        style={{
          zoom: scale,
          position: 'absolute',
          left: 0,
          top: 0,
          // 用 100%（父级=节点宽度）：zoom 已经负责缩放，若再除以 scale 会随缩放变窄，
          // 右侧按钮就会"一直在动"。100% 保证屏幕右边缘始终贴在卡片右边缘。
          width: '100%',
          zIndex: 41,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          paddingLeft: `${2 / scale}px`,
          pointerEvents: 'none',
        }}
      >
        <div
          className={`task-node-header-scale-box--nameplate ${isMini ? 'task-node-header-scale-box--mini' : ''}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: isMini ? 20 : 22,
            padding: `0 ${isMini ? 6 : 7}px`,
            pointerEvents: 'none',
          }}
        >
          {children}
        </div>

      </div>
    )
  }
  return (
    <div
      className="task-node-header-scale-box"
      style={{
        zoom: scale,
        width: `${100 / scale}%`,
        position: 'relative',
        zIndex: 41,
        // 卡内模式：标题区严格限制在卡片宽度内，文字不外溢到卡片外
        overflow: 'hidden',
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
  // LOD 分级（按设计评审方案 C）：
  //   zoom>=0.5 卡内完整；0.35~0.5 卡内紧凑（隐藏图标/操作/状态）；0.2~0.35 浮动名牌；<0.2 迷你名牌
  // 只要画布缩小（zoom<1）就统一用胶囊名牌：不再在 50% 处切换形态，避免视觉突变；
  // 只有 100% 及以上回到卡内常规标题
  // 全档统一胶囊叠层（含 100% 以上），不再有卡内常规标题分支
  const nameplateVariant: 'inline' | 'floating' | 'mini' = zoom < 0.2 ? 'mini' : 'floating'
  const zoomCompacted = zoom < 1
  // 二级标题只在卡内模式出现；进入名牌模式后整行不渲染（不留空白）
  // 胶囊形态下标题区只放一级标题；二级标题由节点侧渲染在卡片内部左上角
  const showSubtitleRow = false
  const subtitleOpacity = 1
  const titleFontSize = nameplateVariant === 'mini' ? 11.7 : 13
  // 名牌模式下贴在卡片左上角的二级标题：有角标就用角标，否则用灰色小字
  const cornerSubtitleNode: React.ReactNode = !showSubtitle
    ? null
    : subtitleBadge
      ? (
          <span
            className="task-node-header-subtitle-badge"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 17,
              padding: '0 6px',
              borderRadius: 6,
              border: `1px solid ${subtitleBadge.borderColor}`,
              background: subtitleBadge.background,
              color: subtitleBadge.textColor ?? subtitleBadge.color,
              fontSize: 10.5,
              fontWeight: 500,
              lineHeight: '15px',
              letterSpacing: 0.3,
              whiteSpace: 'nowrap',
            }}
          >
            {subtitleBadge.label}
          </span>
        )
      : subtitle.trim()
        ? (
            <span style={{ fontSize: 11, lineHeight: 1.2, color: 'rgba(150, 160, 175, 0.92)', whiteSpace: 'nowrap' }}>
              {subtitle}
            </span>
          )
        : null
  if (!showMeta) {
    return (
      <HeaderScaleBox scale={scale} variant={nameplateVariant} zoom={zoom}>
      <div
        className="task-node-header task-node-header--compact"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
          // 生成中遮罩（inset:0 + backdrop-blur）会盖住整个节点，标题必须叠在遮罩之上才不被糊住
          position: 'relative',
          zIndex: 41,
        }}
      >
        {/* 类别色条：3×12 的小标记（不是整条标题栏的左边框），避免缩小时像一根旗杆 */}
        {accentColor && (
          <span
            className="task-node-header-accent"
            style={{
              width: 3,
              height: nameplateVariant === 'mini' ? 10 : 12,
              borderRadius: 1.5,
              background: accentColor,
              flexShrink: 0,
            }}
          />
        )}
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
        <div style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Text
            className="task-node-header-compact-title"
            size="sm"
            fw={600}
            style={{
              color: nodeShellText,
              fontSize: titleFontSize,
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
              // 名牌模式：整条标题不能撑破名牌，超出用省略号（名牌最大宽已按 4 个字留够）
              ...(zoomCompacted ? { overflow: 'visible', textOverflow: 'clip' } : null),
            }}
            title={currentLabel}
          >
            {currentLabel}
          </Text>
          {/* 类型角标与一级标题同处一层：避免被上层名牌胶囊（z-index 41 深灰底）遮挡后显得发暗 */}
          {showSubtitle && subtitleBadge && (
            <span
              className="task-node-header-subtitle-badge"
              title={subtitleBadge.label}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: 17,
                padding: '0 6px',
                borderRadius: 6,
                border: `1px solid ${subtitleBadge.borderColor}`,
                background: subtitleBadge.background,
                color: subtitleBadge.textColor ?? subtitleBadge.color,
                fontSize: 10.5,
                fontWeight: 500,
                lineHeight: '15px',
                letterSpacing: 0.3,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {subtitleBadge.label}
            </span>
          )}
          {showSubtitleRow && (subtitleBadge ? (
            <span
              className="task-node-header-subtitle-badge"
              title={subtitleBadge.label}
              style={{
                opacity: subtitleOpacity,
                transition: 'opacity 120ms ease',
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
                transition: 'opacity 120ms ease',
                maxWidth: '100%',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
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
    <HeaderScaleBox scale={scale} variant={nameplateVariant} zoom={zoom}>
    <div
      className="task-node-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 12,
        cursor: 'grab',
        // 同上：标题栏压在生成中遮罩之上，避免一级/二级标题被模糊遮挡
        position: 'relative',
        zIndex: 41,
      }}
    >
      {/* 类别色条：同紧凑分支，3×12 小标记 */}
      {accentColor && (
        <span
          className="task-node-header-accent"
          style={{
            width: 3,
            height: nameplateVariant === 'mini' ? 10 : 12,
            borderRadius: 1.5,
            background: accentColor,
            flexShrink: 0,
          }}
        />
      )}
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
                    fontSize: titleFontSize,
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
              {showSubtitleRow && (
                <Text
                  className="task-node-header-subtitle"
                  size="xs"
                  c="dimmed"
                  style={{
                    marginTop: 2,
                    opacity: subtitleOpacity,
                    transition: 'opacity 120ms ease',
                    maxWidth: '100%',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {subtitle}
                </Text>
              )}
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
