/** 从粘贴事件的文件列表中提取可上传的图片和视频。 */
export function extractPastedMediaFiles(files: Iterable<File>): File[] {
  return Array.from(files).filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/'));
}
