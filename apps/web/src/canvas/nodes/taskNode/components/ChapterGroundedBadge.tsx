import React from 'react'
import { Badge } from '@mantine/core'

import type { ChapterGroundedProductionMetadata } from '../../../productionMeta'
import { $, $t } from '../../../i18n'

type ChapterGroundedBadgeProps = {
  metadata: ChapterGroundedProductionMetadata
}

function buildBadgeLabel(metadata: ChapterGroundedProductionMetadata): string {
  const missingCount = metadata.lockedAnchors.missing.length
  if (metadata.authorityBaseFrame.status === 'confirmed') {
    return missingCount > 0 ? $t('章锁·{{v1}}缺口', { v1: missingCount }) : $('章锁·已定')
  }
  return missingCount > 0 ? $t('章锁·{{v1}}待补', { v1: missingCount }) : $('章锁·待基底')
}

export function ChapterGroundedBadge({ metadata }: ChapterGroundedBadgeProps): JSX.Element {
  const confirmed = metadata.authorityBaseFrame.status === 'confirmed'
  const badgeColor = confirmed ? 'teal' : 'yellow'

  return (
    <div className="tc-task-node__chapter-grounded-badge">
      <Badge
        className="tc-task-node__chapter-grounded-badge-chip"
        size="xs"
        radius="sm"
        color={badgeColor}
        variant={confirmed ? 'light' : 'outline'}
      >
        {buildBadgeLabel(metadata)}
      </Badge>
    </div>
  )
}
