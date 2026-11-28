module.exports = {
  preset: 'ts-jest',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { isolatedModules: true, rootDir: '.' } }],
  },
  collectCoverageFrom: ['src/**/*.(t|j)s', '!src/main.ts'],
  coverageDirectory: './coverage',
  /**
   * B-15：阈值棘轮 + 目录级下限。
   *
   * 基线实测（2026-11-28，本机全量 --runInBand，含 4 个 env 门控套件跳过、
   * 1 个 Windows symlink 权限失败；CI 在 Linux 上会跑满，故本机值是保守下界）：
   *   全局        statements 72.17 / branches 61.89 / functions 66.91 / lines 73.89
   *   src/file    67.07 / 55.68 / 67.70 / 69.05
   *   src/share   69.98 / 57.95 / 56.30 / 71.13
   *   src/api-key 70.08 / 57.45 / 43.10 / 69.62
   *   src/folder  80.00 / 69.23 / 78.18 / 80.64
   *   src/tag     93.47 / 81.66 / 100   / 92.94（仅 src/tag 直属文件）
   *   src/common/interceptors 100 / 100 / 100 / 100
   *
   * 注意口径差异：文本表格按目录分行（src/tag 与 src/tag/dto 各一行），而下面的
   * 路径前缀阈值会把子目录一并计入。src/tag/ 前缀实测为
   * statements 81.35 / branches 68.05 / functions 68.42 / lines 81.65，阈值按此设定。
   *
   * 目录级下限的作用：全局均值会被大量低风险文件稀释，新增未测模块只要不动均值
   * 就能过门禁。高风险域（上传/下载/分享/鉴权/响应契约）必须各自守住自己的水位。
   * 上调水位时请同步更新上面的实测记录，不要凭感觉钉数字。
   */
  coverageThreshold: {
    global: {
      branches: 58,
      functions: 63,
      lines: 70,
      statements: 70,
    },
    'src/file/': {
      branches: 52,
      functions: 64,
      lines: 66,
      statements: 65,
    },
    'src/share/': {
      branches: 55,
      functions: 53,
      lines: 68,
      statements: 67,
    },
    'src/api-key/': {
      branches: 54,
      functions: 40,
      lines: 66,
      statements: 67,
    },
    'src/folder/': {
      branches: 66,
      functions: 75,
      lines: 77,
      statements: 77,
    },
    'src/tag/': {
      branches: 65,
      functions: 65,
      lines: 78,
      statements: 78,
    },
    // 全局成功响应契约：前后端共同依赖，不允许任何未测分支
    'src/common/interceptors/': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
};
