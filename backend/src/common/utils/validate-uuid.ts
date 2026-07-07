/**
 * UUID v4 格式校验（含防御性输入转换）
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUUID(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return UUID_REGEX.test(value);
}

export function validateUUID(value: unknown, fieldName: string): asserts value is string {
  if (!isValidUUID(value)) {
    throw new Error(`无效的 ${fieldName}: 必须是格式正确的 UUID`);
  }
}

export function validateUUIDArray(values: unknown[], fieldName: string): asserts values is string[] {
  for (const v of values) {
    if (!isValidUUID(v)) {
      throw new Error(`无效的 ${fieldName}: 包含非 UUID 格式的值 "${String(v).slice(0, 20)}..."`);
    }
  }
}
