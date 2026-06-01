(function hardenLeafletPopup(){
  if (!window.L || !L.Layer?.prototype?.bindPopup) return;
  const blockedTags = /^(script|iframe|object|embed|link|meta)$/i;
  function sanitizePopupHTML(html) {
    if (typeof html !== 'string') return html;
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('*').forEach(el => {
      if (blockedTags.test(el.tagName)) { el.remove(); return; }
      [...el.attributes].forEach(attr => {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || '').trim().toLowerCase();
        if (name.startsWith('on') || ((name === 'href' || name === 'src' || name === 'xlink:href') && value.startsWith('javascript:'))) {
          el.removeAttribute(attr.name);
        }
      });
    });
    return template.innerHTML;
  }
  const bindPopup = L.Layer.prototype.bindPopup;
  L.Layer.prototype.bindPopup = function(content, options) {
    const safeContent = typeof content === 'function'
      ? function(layer) { return sanitizePopupHTML(content.call(this, layer)); }
      : sanitizePopupHTML(content);
    return bindPopup.call(this, safeContent, options);
  };
  window.TAINT_SECURITY = Object.freeze({ ...(window.TAINT_SECURITY || {}), leafletPopupSanitized: true });
})();