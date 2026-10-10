(() => {
  const key = 'astra-colossus-theme';
  let theme = 'dark';
  try { if (localStorage.getItem(key) === 'light') theme = 'light'; } catch {}
  const apply = value => {
    theme = value === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f3f7f8' : '#071321');
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
})();
