(() => {
  const key = 'astra-colossus-theme';
  const media = matchMedia('(prefers-color-scheme: dark)');
  let theme = 'auto';
  try { if (['auto', 'light', 'dark'].includes(localStorage.getItem(key))) theme = localStorage.getItem(key); } catch {}
  const apply = value => {
    theme = ['auto', 'light', 'dark'].includes(value) ? value : 'auto';
    const resolved = theme === 'auto' ? media.matches ? 'dark' : 'light' : theme;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#f3f7f8' : '#070c16');
    document.querySelectorAll('[data-theme-control]').forEach(control => { control.value = theme; });
  };
  apply(theme);
  document.addEventListener('DOMContentLoaded', () => {
    apply(theme);
    document.querySelectorAll('[data-theme-control]').forEach(control => control.addEventListener('change', () => {
      apply(control.value);
      try { localStorage.setItem(key, theme); } catch {}
    }));
  });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
  media.addEventListener('change', () => { if (theme === 'auto') apply('auto'); });
})();
