import { ref, onMounted, onUnmounted, computed } from 'vue';

// ============================================================
// Multi-breakpoint responsive system
// Breakpoints: xs(≤480) / sm(≤768) / md(≤1024) / lg(≤1440) / xl(>1440)
// ============================================================

export type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const BREAKPOINTS = {
  xs: 480,
  sm: 768,
  md: 1024,
  lg: 1440,
} as const;

function getBreakpoint(width: number): Breakpoint {
  if (width <= BREAKPOINTS.xs) return 'xs';
  if (width <= BREAKPOINTS.sm) return 'sm';
  if (width <= BREAKPOINTS.md) return 'md';
  if (width <= BREAKPOINTS.lg) return 'lg';
  return 'xl';
}

function getInitialWidth(): number {
  if (typeof window === 'undefined') return 1440;
  return window.innerWidth;
}

// Singleton state
const windowWidth = ref(getInitialWidth());
const currentBreakpoint = ref<Breakpoint>(getBreakpoint(getInitialWidth()));

// Backward compat: isMobile = ≤768px (same behavior as before)
const isMobile = computed(() => currentBreakpoint.value === 'xs' || currentBreakpoint.value === 'sm');
const isTablet = computed(() => currentBreakpoint.value === 'md');
const isPhone = computed(() => currentBreakpoint.value === 'xs');
const isDesktop = computed(() => currentBreakpoint.value === 'lg' || currentBreakpoint.value === 'xl');

let listenerCount = 0;
let resizeHandler: (() => void) | null = null;

function updateWidth() {
  windowWidth.value = window.innerWidth;
  currentBreakpoint.value = getBreakpoint(window.innerWidth);
}

export function useMobile() {
  onMounted(() => {
    if (listenerCount === 0) {
      resizeHandler = () => updateWidth();
      window.addEventListener('resize', resizeHandler, { passive: true });
      updateWidth();
    }
    listenerCount++;
  });

  onUnmounted(() => {
    listenerCount = Math.max(0, listenerCount - 1);
    if (listenerCount === 0 && resizeHandler) {
      window.removeEventListener('resize', resizeHandler);
      resizeHandler = null;
    }
  });

  return isMobile;
}

/**
 * Extended responsive composable — returns all breakpoint info.
 * Use in components that need finer-grained responsive control.
 */
export function useBreakpoint() {
  onMounted(() => {
    if (listenerCount === 0) {
      resizeHandler = () => updateWidth();
      window.addEventListener('resize', resizeHandler, { passive: true });
      updateWidth();
    }
    listenerCount++;
  });

  onUnmounted(() => {
    listenerCount = Math.max(0, listenerCount - 1);
    if (listenerCount === 0 && resizeHandler) {
      window.removeEventListener('resize', resizeHandler);
      resizeHandler = null;
    }
  });

  return {
    breakpoint: currentBreakpoint,
    width: windowWidth,
    isMobile,
    isTablet,
    isPhone,
    isDesktop,
  };
}
