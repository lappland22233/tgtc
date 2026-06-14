---
name: static-code-review
overview: 对项目的所有后端（NestJS/TypeScript）和前端（Vue 3/TypeScript）代码文件进行全面的静态代码审查，按严重程度分类问题，生成结构化的 Markdown 审查报告 sc.md。
todos:
  - id: explore-remaining
    content: 使用 [subagent:code-explorer] 补充审查尚未细读的前端页面和后端模块文件
    status: completed
  - id: audit-security
    content: 审查安全漏洞：SMTP密码泄露、Token安全、授权缺失、注入风险、CORS配置
    status: completed
    dependencies:
      - explore-remaining
  - id: audit-logic
    content: 审查逻辑错误：边界条件、空值处理、事务一致性、业务逻辑对称性
    status: completed
    dependencies:
      - explore-remaining
  - id: audit-performance
    content: 审查性能问题：内存泄漏（定时器/EventEmitter/BroadcastChannel）、N+1查询、并发竞态
    status: completed
    dependencies:
      - explore-remaining
  - id: audit-standards
    content: 审查代码规范：类型安全（any/as断言）、魔法值、冗余代码、日志规范
    status: completed
    dependencies:
      - explore-remaining
  - id: audit-architecture
    content: 审查架构设计：模块耦合、职责分离、循环依赖、依赖注入
    status: completed
    dependencies:
      - explore-remaining
  - id: generate-report
    content: 汇总所有发现的问题，按严重/警告/建议三级分类排序，生成完整 sc.md 报告并写入项目根目录
    status: completed
    dependencies:
      - audit-security
      - audit-logic
      - audit-performance
      - audit-standards
      - audit-architecture
---

## 用户需求

对项目执行一次全面的静态代码审查，扫描并分析所有源代码文件，查找潜在的代码规范违规、逻辑错误、安全漏洞及性能问题。将所有发现的问题按严重程度分类为严重、警告、建议三级，每项问题附具体文件路径、行号及修复建议，修复建议需包含代码修改示例。最终将完整审查报告写入项目根目录下的 `sc.md` 文件中。

## 产品概述

生成一份结构化的静态代码审查报告，面向项目开发者，帮助系统性地发现和修复代码质量问题。

## 核心功能

- 扫描 backend/src/ 下全部 TypeScript 文件（含 auth/、user/、file/、admin/、telegram/、mailer/、config/、tasks/、common/、database/ 模块）
- 扫描 frontend/src/ 下全部 Vue 组件和 TypeScript 文件（含 views/、components/、stores/、router/、api/、types/、utils/）
- 问题按严重、警告、建议三级分类，每类下按文件路径排序
- 每项问题包含：严重级别、文件路径、行号、问题标题、详细描述、修复建议（代码 diff 格式）
- 报告包含完整目录、分类汇总统计、快速导航锚点
- 最终输出写入项目根目录 `sc.md` 文件

## 审查方法论

### 审查维度与检查项

#### 安全漏洞

| 检查项 | 检测重点 |
| --- | --- |
| 敏感信息泄露 | SMTP密码、JWT私钥、Telegram Token是否通过API或日志暴露 |
| 认证绕过 | JWT验证完整性、Cookie安全属性（httpOnly/secure/sameSite）、未认证公开端点 |
| 授权缺失 | RolesGuard覆盖范围、超管操作的保护、跨用户数据访问校验 |
| 注入风险 | SQL注入（原生查询参数化）、文件名路径穿越、HTML注入 |
| CORS配置 | 通配符origin、credentials配合 |
| 密码安全 | 哈希算法选择、验证码哈希存储、暴力破解防护 |


#### 逻辑错误

| 检查项 | 检测重点 |
| --- | --- |
| 边界条件 | page/limit等参数的越界值、空数组/空字符串处理 |
| 空值处理 | 可选属性访问前的null检查、?.和??使用 |
| 异步错误处理 | try/catch覆盖完整性、finally资源释放 |
| 事务一致性 | 事务内操作完整性、rollback覆盖 |
| 业务逻辑一致性 | 文件所有权校验、角色权限校验的对称性 |


#### 性能问题

| 检查项 | 检测重点 |
| --- | --- |
| N+1查询 | findAll + 循环内单独查询 |
| 内存泄漏 | EventEmitter未注销、setInterval/定时器未清理、BroadcastChannel未关闭 |
| 并发竞态 | 原子操作的正确性、事务隔离级别 |
| 大数据处理 | 全量查询无分页、Buffer全量加载、流是否正确使用 |
| 缓存策略 | Cache是否考虑失效、TTL设置 |


#### 代码规范

| 检查项 | 检测重点 |
| --- | --- |
| 类型安全 | any类型使用、as强制类型断言、隐式any |
| 魔法值 | 硬编码数字、字符串常量未提取 |
| 命名一致性 | 变量/函数名风格、DTO命名规范 |
| 冗余代码 | 已废弃方法未删除、空provider数组、重复工具函数 |
| 日志规范 | console vs Logger使用、敏感信息脱敏 |


#### 架构设计

| 检查项 | 检测重点 |
| --- | --- |
| 模块耦合 | Service间直接依赖、循环引用风险 |
| 职责分离 | 单个文件/方法过大、Controller混杂业务逻辑 |
| 依赖注入 | DI使用规范性、provider注册完整性 |


### 审查执行流程

1. **逐文件审查**：使用 code-explorer 子代理分批读取所有源代码文件
2. **问题识别**：对照检查表逐项标记，记录文件路径+行号+问题描述
3. **严重性判定**：按影响力矩阵打分（影响范围 x 利用难度 x 修复紧迫性）
4. **报告生成**：撰写 sc.md，包含目录、汇总统计、分类详细列表、修复示例

### 严重性判定标准

| 级别 | 判定条件 |
| --- | --- |
| **严重** | 可直接导致数据泄露/权限绕过/服务不可用的安全漏洞或逻辑缺陷 |
| **警告** | 存在潜在风险或违反最佳实践，在特定条件下可被利用 |
| **建议** | 代码质量改进点，不影响功能但提升可维护性 |


## 实现策略

- 对已读取并分析的关键文件（auth.service.ts、file.service.ts、admin.service.ts、user.service.ts、main.ts、rate-limit.service.ts、telegram.service.ts、mailer.service.ts、jwt.strategy.ts、thumbnail-crypto.service.ts、file.controller.ts、auth.controller.ts、admin.controller.ts、UploadModal.vue、FileList.vue、Config.vue、App.vue、client.ts、auth.ts、files.ts、router/index.ts、thumbnail.ts、所有entity/dto/guard/decorator文件）直接提取已发现的问题
- 对尚未细读的辅助文件（剩余Vue页面、DTO文件、module文件、migration文件），使用子代理补充审查
- 问题按严重→警告→建议顺序写入报告
- 报告使用Markdown锚点实现目录跳转

## 目录结构

```
c:/预备重构/
└── sc.md                    # [NEW] 静态代码审查报告
    ├── 目录（锚点链接）
    ├── 审查概览（统计摘要表格）
    ├── 严重问题（按文件路径排序）
    ├── 警告问题（按文件路径排序）
    ├── 建议问题（按文件路径排序）
    └── 附录：审查覆盖文件清单
```

## 使用的代理扩展

### SubAgent

- **code-explorer**
- 用途：批量读取尚未细读的辅助文件（剩余Vue页面如Login、Register、Dashboard、Upload、Layout、Settings等，以及admin目录下的Dashboard/Files/Users页面、DTD文件、module文件、剩余entity文件）
- 预期结果：完成对所有源代码文件的全面审查覆盖，确保不遗漏任何文件