/**
 * file-type 包是 ESM-only，Jest 默认 CommonJS 环境下无法直接 require。
 * 此 mock 提供 fileTypeFromBuffer 的桩实现，测试中不依赖真实文件类型检测。
 */
export async function fileTypeFromBuffer(
  buffer: Buffer,
): Promise<{ ext: string; mime: string } | null> {
  // 简单的 magic bytes 检测，测试用
  if (!buffer || buffer.length < 4) return null;

  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' };
  }
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { ext: 'gif', mime: 'image/gif' };
  }

  return null;
}
