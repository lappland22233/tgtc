import { ref, onMounted, onUnmounted } from 'vue';

const MOBILE_BREAKPOINT = 768;
const MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

// 初始值优先用 matchMedia 计算（与 onMounted 中的监听使用同一查询），
// 避免 innerWidth 与 matchMedia 在边界值上判定不一致；matchMedia 不可用时回退 innerWidth。
function getInitialIsMobile(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(MEDIA_QUERY).matches;
  }
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

// 单例模式：确保所有组件共享同一个 isMobile ref
const isMobile = ref(getInitialIsMobile());

let listenerCount = 0;
let mediaQueryList: MediaQueryList | null = null;

function handleChange(e: MediaQueryListEvent) {
  isMobile.value = e.matches;
}

export function useMobile() {
  onMounted(() => {
    if (listenerCount === 0) {
      mediaQueryList = window.matchMedia(MEDIA_QUERY);
      // 初始状态同步（防止 SSR/hydration 不一致）
      isMobile.value = mediaQueryList.matches;
      mediaQueryList.addEventListener('change', handleChange);
    }
    listenerCount++;
  });

  onUnmounted(() => {
    // 非负保护：避免生命周期未严格配对时计数变负，导致监听器无法被正确移除
    listenerCount = Math.max(0, listenerCount - 1);
    if (listenerCount === 0 && mediaQueryList) {
      mediaQueryList.removeEventListener('change', handleChange);
      mediaQueryList = null;
    }
  });

  return isMobile;
}
