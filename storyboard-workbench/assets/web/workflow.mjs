export function draftVariant(project, shot) {
  const selected = shot.variants.find(v => v.id === shot.selectedVariantId);
  if (selected) return selected;
  if (project.workflowMode === 'agent-default') return shot.variants.find(v => v.id === shot.recommendation?.variantId);
}

export function variantStatus(project, shot, variant) {
  if (!variant) return '待规划';
  const selected = shot.selectedVariantId === variant.id;
  if (selected && shot.approval?.variantId === variant.id && shot.approval.variantVersion === variant.version) return '用户已确认当前版本';
  if (selected) return '用户已选择 · 待确认';
  if (project.workflowMode === 'agent-default' && shot.recommendation?.variantId === variant.id) return 'Agent 默认方案 · 待审';
  return '备选 · 待审';
}
