import { readonly, ref } from 'vue';

const isPageVisible = ref(typeof document === 'undefined' || document.visibilityState === 'visible');
let initialized = false;

function syncVisibility() {
  isPageVisible.value = document.visibilityState === 'visible';
}

function ensureVisibilityListener() {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;
  document.addEventListener('visibilitychange', syncVisibility, { passive: true });
}

ensureVisibilityListener();

export function usePageVisibility() {
  ensureVisibilityListener();
  return {
    isPageVisible: readonly(isPageVisible),
    isPageHidden: readonly({
      get value() {
        return !isPageVisible.value;
      },
    }),
  };
}

export { isPageVisible };
