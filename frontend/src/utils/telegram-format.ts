import type { TelegramAccountRuntimeView } from '@/api/telegram-accounts';

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function featureSourceText(source: string | undefined): string {
  switch (source) {
    case 'runtime':
      return '来源：运行时配置';
    case 'env':
      return '来源：环境变量';
    case 'forced_disabled':
      return '来源：强制关闭';
    default:
      return '来源：默认值';
  }
}

export function testStatusText(status: 'untested' | 'ok' | 'failed' | undefined): string {
  if (status === 'ok') return '通过';
  if (status === 'failed') return '失败';
  return '未测试';
}

const ERROR_KIND_TEXT: Record<string, string> = {
  flood: '限流',
  unavailable: '不可用',
  timeout: '超时',
  network: '网络',
  other: '其它',
};

export function errorKindText(kind: string | null): string {
  if (!kind) return '无';
  return ERROR_KIND_TEXT[kind] ?? kind;
}

export function formatBandwidth(mbps: number): string {
  if (!Number.isFinite(mbps) || mbps <= 0) return '—';
  return `${mbps.toFixed(1)} Mbps`;
}

export function formatSuccessRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

export function formatCooldown(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.ceil(seconds / 60)} 分钟`;
}

export function envHealthTheme(runtime: TelegramAccountRuntimeView): 'success' | 'warning' | 'danger' {
  if (runtime.coolingDown) return 'danger';
  if (runtime.consecutiveFailures > 0) return 'warning';
  return 'success';
}

export function envHealthText(runtime: TelegramAccountRuntimeView): string {
  if (runtime.coolingDown) return '冷却中';
  if (runtime.consecutiveFailures > 0) return `连续失败 ${runtime.consecutiveFailures} 次`;
  return '正常';
}

/** 运行态摘要（数据库账号行与环境变量账号区共用） */
export function runtimeSummary(runtime: TelegramAccountRuntimeView): string {
  const parts = [
    `在飞 ${runtime.inflight}/${runtime.maxInflight}`,
    `成功率 ${formatSuccessRate(runtime.successRate)}`,
  ];
  if (runtime.coolingDown) parts.push(`冷却 ${formatCooldown(runtime.cooldownRemainingMs)}`);
  return parts.join(' · ');
}
