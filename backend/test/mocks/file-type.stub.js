/**
 * file-type v20 为 ESM-only 包（exports 无 require 条件），ts-jest CJS 环境无法加载。
 * 此 stub 供 jest moduleNameMapper 使用：凡测试链路 import 到 file-type 时替换为可 require 的桩。
 * 返回 undefined 表示类型嗅探未命中，与生产代码的「未知类型」分支一致。
 */
module.exports = {
  fileTypeFromBuffer: async () => undefined,
  fileTypeFromFile: async () => undefined,
};
