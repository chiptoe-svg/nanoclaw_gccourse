const draftState = { dirty: false };

export function initDraftBanner() {
  document.getElementById('draft-discard').addEventListener('click', () => alert('TODO: discard (Task 6.8)'));
  document.getElementById('draft-save').addEventListener('click', () => alert('TODO: save to library (Task 6.8)'));
  document.getElementById('draft-apply').addEventListener('click', () => alert('TODO: apply to agent (Task 6.8)'));
}

export function showDraftBanner(message) {
  draftState.dirty = true;
  const banner = document.getElementById('draft-banner');
  document.getElementById('draft-message').textContent = message;
  banner.hidden = false;
}

export function hideDraftBanner() {
  draftState.dirty = false;
  document.getElementById('draft-banner').hidden = true;
}
