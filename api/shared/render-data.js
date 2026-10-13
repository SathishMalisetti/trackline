// Values used by the existing UI in attribute/inline-handler contexts.
// Free-form labels remain unrestricted and are escaped by the renderer.
function validateRenderData(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['id', 'memberId', 'kidId', 'driverId', 'choreId'].includes(key) && child != null && child !== '') {
      if (typeof child !== 'string' || !/^[A-Za-z0-9_:.\-]+$/.test(child)) {
        throw Object.assign(new Error('Invalid record identifier.'), { status: 400 });
      }
    }
    if (key === 'color' && child != null && child !== '') {
      if (typeof child !== 'string' || !/^(#[a-fA-F0-9]{3,8}|[a-zA-Z]+|var\(--[a-zA-Z0-9-]+\))$/.test(child)) {
        throw Object.assign(new Error('Invalid display color.'), { status: 400 });
      }
    }
    if (child && typeof child === 'object') validateRenderData(child);
  }
}
module.exports = { validateRenderData };
