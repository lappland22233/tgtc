(function () {
  try {
    var stored = localStorage.getItem('filecloud-theme');
    var dark =
      stored === 'dark' ||
      (stored !== 'light' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    var theme = dark ? 'dark' : 'light';
    var root = document.documentElement;
    root.setAttribute('data-theme', theme);
    if (dark) {
      root.setAttribute('theme-mode', 'dark');
    } else {
      root.removeAttribute('theme-mode');
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', dark ? '#1b211e' : '#f6f5ef');
    }
  } catch (_e) {
    // 隐私模式/受限环境忽略存储读取失败，交由 critical.css 媒体查询兜底
  }
})();
