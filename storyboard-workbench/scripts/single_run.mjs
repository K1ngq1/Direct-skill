const text = value => typeof value === 'string' && Boolean(value.trim());

// This opt-in belongs to the frozen plan, never to a media result or an incoming script.
export function singleRunEnabled(plan) {
  const policy = plan?.run?.automation;
  if (policy === undefined) return false;
  if (plan.schemaVersion !== 2 || policy === null || typeof policy !== 'object' || Array.isArray(policy) ||
      Object.keys(policy).some(key => !['mode', 'userRequest', 'assetSelection', 'imageGeneration', 'videoGeneration'].includes(key)) ||
      policy.mode !== 'single-run' || !text(policy.userRequest) || policy.assetSelection !== 'agent' ||
      policy.imageGeneration !== true || policy.videoGeneration !== false) {
    throw new Error('单次自动制作须为 v2 项目，记录用户原话、Agent 采用图片、允许生图且禁止视频生成');
  }
  return true;
}

export function agentImageSelected(plan, image) {
  if (!singleRunEnabled(plan)) return false;
  const output = image?.output ?? image;
  return (!image?.output || image.status === 'succeeded') && image?.approval?.status === 'pending' && image.approval.by === null &&
    image.selection?.by === 'agent' && text(image.selection.reason) &&
    Number.isFinite(Date.parse(image.selection.selectedAt)) &&
    image.review?.status === 'usable' && text(image.review.reason) && text(image.review.reviewer) &&
    /^[a-f0-9]{64}$/i.test(output?.sha256 ?? '') && image.review.outputSha256 === output.sha256;
}

export function userImageConfirmed(image) {
  return image?.approval?.status === 'confirmed' && image.approval.by === 'user' &&
    Number.isFinite(Date.parse(image.approval.confirmedAt));
}
