import { ActionIcon, Button, Divider, Group, Menu, Text, Tooltip } from '@mantine/core'
import { IconMaximize, IconMap, IconRoute, IconLayoutGrid, IconBrush, IconZoomIn, IconZoomOut } from '@tabler/icons-react'

type CanvasBottomToolbarProps = {
  /** 当前画布缩放百分比（0-800） */
  zoomPercent: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFitView: () => void
  onZoomTo: (zoom: number) => void
  /** 小地图显隐 */
  miniMapVisible: boolean
  onToggleMiniMap: () => void
  /** 连线显隐 */
  edgesVisible: boolean
  onToggleEdges: () => void
  /** 整理画布（恢复默认布局）；未提供时点击只做适合屏幕 */
  onArrange?: () => void
}

/**
 * 画布左下角工具条：资产管理 / 整理画布 / 小地图 / 连线显隐 / 网格吸附 / 缩放菜单。
 * 缩放菜单点击画布任意区域自动关闭（Mantine Menu 默认行为）。
 */
export function CanvasBottomToolbar({
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onFitView,
  onZoomTo,
  miniMapVisible,
  onToggleMiniMap,
  edgesVisible,
  onToggleEdges,
  onArrange,
}: CanvasBottomToolbarProps): JSX.Element {
  return (
    <div
      className="tc-canvas-bottom-toolbar"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 资产管理：暂不处理 */}
      <Tooltip label="资产管理" position="top" withArrow>
        <ActionIcon className="tc-canvas-bottom-toolbar__action" variant="subtle" color="gray" size="md">
          <IconBrush size={16} />
        </ActionIcon>
      </Tooltip>

      <Divider orientation="vertical" className="tc-canvas-bottom-toolbar__divider" />

      {/* 整理画布：恢复默认打开时的布局（lens 模式重新投影；否则适合屏幕） */}
      <Tooltip label="整理画布 (⌥⌘F)" position="top" withArrow>
        <ActionIcon
          className="tc-canvas-bottom-toolbar__action"
          variant="subtle"
          color="gray"
          size="md"
          onClick={onArrange}
        >
          <IconMaximize size={16} />
        </ActionIcon>
      </Tooltip>

      {/* 画布小地图：默认隐藏，点击切换 */}
      <Tooltip label={miniMapVisible ? '隐藏小地图' : '显示小地图'} position="top" withArrow>
        <ActionIcon
          className="tc-canvas-bottom-toolbar__action"
          variant={miniMapVisible ? 'light' : 'subtle'}
          color={miniMapVisible ? 'blue' : 'gray'}
          size="md"
          onClick={onToggleMiniMap}
        >
          <IconMap size={16} />
        </ActionIcon>
      </Tooltip>

      {/* 显示/隐藏连线 */}
      <Tooltip label={edgesVisible ? '隐藏节点连线' : '显示节点连线'} position="top" withArrow>
        <ActionIcon
          className="tc-canvas-bottom-toolbar__action"
          variant={edgesVisible ? 'light' : 'subtle'}
          color={edgesVisible ? 'blue' : 'gray'}
          size="md"
          onClick={onToggleEdges}
        >
          <IconRoute size={16} />
        </ActionIcon>
      </Tooltip>

      {/* 网格吸附：暂不处理 */}
      <Tooltip label="网格吸附" position="top" withArrow>
        <ActionIcon className="tc-canvas-bottom-toolbar__action" variant="subtle" color="gray" size="md">
          <IconLayoutGrid size={16} />
        </ActionIcon>
      </Tooltip>

      <Divider orientation="vertical" className="tc-canvas-bottom-toolbar__divider" />

      {/* 缩放菜单：放大/缩小/适合屏幕/指定比例 */}
      <Menu shadow="md" width={200} position="top-start" withinPortal>
        <Menu.Target>
          <Button
            className="tc-canvas-bottom-toolbar__zoom"
            variant="subtle"
            color="gray"
            size="compact-sm"
            data-zoom-percent
          >
            {zoomPercent}%
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconZoomIn size={14} />} onClick={onZoomIn}>
            <Group justify="space-between" wrap="nowrap">
              <span>放大</span>
              <Text span size="xs" c="dimmed">⌘ +</Text>
            </Group>
          </Menu.Item>
          <Menu.Item leftSection={<IconZoomOut size={14} />} onClick={onZoomOut}>
            <Group justify="space-between" wrap="nowrap">
              <span>缩小</span>
              <Text span size="xs" c="dimmed">⌘ −</Text>
            </Group>
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item leftSection={<IconMaximize size={14} />} onClick={onFitView}>
            <Group justify="space-between" wrap="nowrap">
              <span>适合屏幕</span>
              <Text span size="xs" c="dimmed">⌘ 0</Text>
            </Group>
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item onClick={() => onZoomTo(0.5)}>缩放至 50%</Menu.Item>
          <Menu.Item onClick={() => onZoomTo(1)}>缩放至 100%</Menu.Item>
          <Menu.Item onClick={() => onZoomTo(4)}>缩放至 400%</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  )
}
