import { ref, onMounted, onUnmounted } from 'vue';

const MOBILE_BREAKPOINT = 768;

// 单例模式：确保所有组件共享同一个 isMobile ref
const isMobile = ref(
  typeof window !== 'undefined' ? window.innerWidth <= MOBILE_BREAKPOINT : false
);

let listenerCount = 0;
let mediaQueryList: MediaQueryList | null = null;

function handleChange(e: MediaQueryListEvent) {
  isMobile.value = e.matches;
}

export function useMobile() {
  onMounted(() => {
    if (listenerCount === 0) {
      mediaQueryList = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
      // 初始状态同步（防止 SSR/hydration 不一致）
      isMobile.value = mediaQueryList.matches;
      mediaQueryList.addEventListener('change', handleChange);
    }
    listenerCount++;
  });

  onUnmounted(() => {
    listenerCount--;
    if (listenerCount === 0 && mediaQueryList) {
      mediaQueryList.removeEventListener('change', handleChange);
      mediaQueryList = null;
    }
  });

  return isMobile;
}
