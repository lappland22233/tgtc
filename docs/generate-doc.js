const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
        ShadingType, PageNumber, PageBreak, LevelFormat } = require('docx');
const fs = require('fs');

const doc = new Document({
    styles: {
        default: { document: { run: { font: "Arial", size: 24 } } },
        paragraphStyles: [
            {
                id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
                run: { size: 36, bold: true, font: "Arial" },
                paragraph: { spacing: { before: 400, after: 200 }, outlineLevel: 0 }
            },
            {
                id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
                run: { size: 28, bold: true, font: "Arial" },
                paragraph: { spacing: { before: 300, after: 150 }, outlineLevel: 1 }
            },
            {
                id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
                run: { size: 24, bold: true, font: "Arial" },
                paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 }
            },
        ]
    },
    numbering: {
        config: [
            {
                reference: "bullets",
                levels: [{
                    level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
                    style: { paragraph: { indent: { left: 720, hanging: 360 } } }
                }]
            },
            {
                reference: "numbers",
                levels: [{
                    level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
                    style: { paragraph: { indent: { left: 720, hanging: 360 } } }
                }]
            }
        ]
    },
    sections: [{
        properties: {
            page: {
                size: { width: 12240, height: 15840 },
                margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
            }
        },
        headers: {
            default: new Header({
                children: [new Paragraph({
                    children: [
                        new TextRun({ text: "TG图床重构概要文档", bold: true }),
                        new TextRun({ text: "\t", size: 24 }),
                        new TextRun({ text: "v2.0", size: 20, color: "666666" })
                    ],
                    tabStops: [{ type: "right", position: 9360 }],
                    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "4f78b4", space: 1 } }
                })]
            })
        },
        footers: {
            default: new Footer({
                children: [new Paragraph({
                    children: [
                        new TextRun({ text: "机密 - 内部使用\t", size: 20, color: "666666" }),
                        new TextRun({ children: ["Page ", PageNumber.CURRENT], size: 20, color: "666666" })
                    ],
                    tabStops: [{ type: "right", position: 9360 }],
                    border: { top: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC", space: 1 } }
                })]
            })
        },
        children: [
            // 标题页
            new Paragraph({ spacing: { before: 2400 } }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: "TG图床", bold: true, size: 72, font: "Arial" })]
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: "代码重构概要文档", size: 48, font: "Arial" })]
            }),
            new Paragraph({ spacing: { before: 600 } }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: "版本: v2.0.0", size: 28, color: "666666" })]
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: "日期: 2026-04-25", size: 28, color: "666666" })]
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: "状态: 计划中", size: 28, color: "666666" })]
            }),

            new Paragraph({ children: [new PageBreak()] }),

            // 目录
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("目录")] }),
            new Paragraph({ children: [new TextRun("1. 项目概述")] }),
            new Paragraph({ children: [new TextRun("2. 当前问题分析")] }),
            new Paragraph({ children: [new TextRun("3. 重构方案设计")] }),
            new Paragraph({ children: [new TextRun("4. 登录模块重构")] }),
            new Paragraph({ children: [new TextRun("5. 数据库设计")] }),
            new Paragraph({ children: [new TextRun("6. 后端架构")] }),
            new Paragraph({ children: [new TextRun("7. 前端改进")] }),
            new Paragraph({ children: [new TextRun("8. 权限体系")] }),
            new Paragraph({ children: [new TextRun("9. 实施计划")] }),

            new Paragraph({ children: [new PageBreak()] }),

            // 1. 项目概述
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("1. 项目概述")] }),
            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("1.1 项目背景")] }),
            new Paragraph({ children: [new TextRun("TG图床是一个基于Telegram的文件存储与访问服务，用户可以通过API上传文件到Telegram频道或群组，并通过随机生成的路径访问文件。项目当前使用Go语言实现，包含约1300行的单文件main.go和简单的HTML管理后台。")] }),

            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("1.2 重构目标")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("实现模块化、可维护的架构")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("重构登录模块，支持多用户体系")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("增强后台管理系统，提升易用性")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("添加数据可视化仪表盘")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("实现完整的操作日志监控")] }),

            new Paragraph({ children: [new PageBreak()] }),

            // 2. 当前问题分析
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("2. 当前问题分析")] }),
            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("2.1 后端问题")] }),

            createTable([
                ["问题类别", "具体问题", "影响程度"],
                ["代码组织", "单文件超过1300行，所有逻辑混在一起", "高"],
                ["模块化缺失", "handler、middleware、service逻辑未分离", "高"],
                ["认证简陋", "仅支持单个API Key，无多用户概念", "高"],
                ["密码明文", "API Key以明文存储在配置文件", "高"],
                ["日志缺失", "无操作日志记录", "中"],
            ]),

            new Paragraph({ spacing: { before: 300 } }),
            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("2.2 前端问题")] }),

            createTable([
                ["问题类别", "具体问题", "影响程度"],
                ["登录简陋", "仅支持输入API Key", "高"],
                ["无用户管理", "无法管理多用户账号", "高"],
                ["体验不佳", "缺乏友好的错误提示和加载状态", "中"],
                ["组件化缺失", "UI组件未抽象，代码重复", "中"],
            ]),

            new Paragraph({ children: [new PageBreak()] }),

            // 3. 重构方案设计
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("3. 重构方案设计")] }),
            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("3.1 分层架构")] }),

            new Paragraph({ children: [new TextRun("采用经典的分层架构设计：")] }),
            new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("Handler Layer - HTTP请求处理、参数校验")] }),
            new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("Middleware Layer - 认证、日志、CORS、限流")] }),
            new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("Service Layer - 业务逻辑、缓存策略")] }),
            new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("Repository Layer - 数据库CRUD操作")] }),
            new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("Data Layer - MySQL、Telegram API")] }),

            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("3.2 重构后目录结构")] }),
            new Paragraph({
                children: [new TextRun({
                    text: `tg-imagebed-refactored/
  cmd/server/main.go           # 应用入口
  internal/
    config/config.go           # 配置管理
    model/models.go            # 数据模型
    repository/                # 数据访问层
      user.go                 # 用户数据访问
      log.go                   # 日志数据访问
      ban.go                   # IP封禁数据访问
    service/                   # 业务逻辑层
      auth.go                 # 认证服务
      user.go                 # 用户管理服务
    handler/                   # HTTP处理器层
      auth.go                 # 认证相关API
      user.go                 # 用户管理API
    middleware/                # 中间件层
      auth.go                 # JWT认证中间件
      rbac.go                 # 权限检查中间件
      cors.go                 # CORS中间件
  admin/                       # 前端管理界面
    css/
    js/
    login.html
    index.html
  migrations/                  # 数据库迁移脚本
  config.json.example          # 配置文件模板`,
                    font: "Consolas"
                })]
            }),

            new Paragraph({ children: [new PageBreak()] }),

            // 4. 登录模块重构
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("4. 登录模块重构")] }),
            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("4.1 认证方式升级")] }),

            createTable([
                ["对比项", "原方案", "新方案"],
                ["认证方式", "单API Key", "用户名+密码(bcrypt)"],
                ["用户管理", "无", "多用户+角色区分"],
                ["会话管理", "简单JWT Token", "Session+JWT双模式"],
                ["密码存储", "明文配置", "bcrypt加密"],
            ]),

            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("4.2 登录流程设计")] }),
            new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("用户输入用户名/密码")] }),
            new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("前端POST /api/auth/login")] }),
            new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("后端验证密码(bcrypt)")] }),
            new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("生成JWT Token + Refresh Token")] }),
            new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("返回Token和用户信息")] }),
            new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("前端存储Token，后续请求携带")] }),

            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("4.3 新增API接口")] }),
            new Paragraph({ children: [new TextRun("认证相关API：")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("POST /api/auth/login - 用户登录")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("POST /api/auth/refresh - 刷新Token")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("GET /api/auth/me - 获取当前用户")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("POST /api/auth/logout - 用户登出")] }),

            new Paragraph({ children: [new PageBreak()] }),

            // 5. 数据库设计
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("5. 数据库设计")] }),
            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("5.1 用户表(users)")] }),
            new Paragraph({
                children: [new TextRun({
                    text: `CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('super_admin', 'admin', 'operator'),
    status ENUM('active', 'disabled'),
    last_login_at TIMESTAMP NULL,
    last_login_ip VARCHAR(45) NULL,
    login_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`,
                    font: "Consolas"
                })]
            }),

            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("5.2 操作日志表(admin_logs)")] }),
            new Paragraph({
                children: [new TextRun({
                    text: `CREATE TABLE admin_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL,
    username VARCHAR(50) NOT NULL,
    action VARCHAR(100) NOT NULL,
    target VARCHAR(255),
    ip VARCHAR(45),
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);`,
                    font: "Consolas"
                })]
            }),

            new Paragraph({ children: [new PageBreak()] }),

            // 6. 后端架构
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("6. 后端架构")] }),
            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("6.1 技术选型")] }),

            createTable([
                ["组件", "选型", "理由"],
                ["密码加密", "golang.org/x/crypto/bcrypt", "Go标准加密库"],
                ["会话管理", "github.com/gorilla/sessions", "成熟的Session库"],
                ["JWT", "github.com/golang-jwt/jwt/v5", "现有项目已在用"],
                ["日志库", "go.uber.org/zap", "高性能，结构化日志"],
                ["HTTP框架", "标准库 + 自定义路由", "轻量，RESTful路由支持"],
            ]),

            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("6.2 核心模块说明")] }),
            new Paragraph({ children: [new TextRun("认证服务(AuthService)：")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("Login - 用户登录验证")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("ValidateToken - Token验证")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("RefreshToken - Token刷新")] }),
            new Paragraph({ children: [new TextRun("用户服务(UserService)：")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("CreateUser - 创建用户")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("UpdateUser - 更新用户")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("DeleteUser - 删除用户")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("ChangePassword - 修改密码")] }),

            new Paragraph({ children: [new PageBreak()] }),

            // 7. 前端改进
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("7. 前端改进")] }),
            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("7.1 登录页面改进")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("美观的用户名/密码输入界面")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("记住登录状态功能")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("友好的错误提示")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("加载状态动画")] }),

            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("7.2 后台管理界面")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("仪表盘 - 统计卡片+Chart.js图表")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("文件管理 - 列表、搜索、分页")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("用户管理 - 增删改查(仅管理员)")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("操作日志 - 时间筛选、操作类型筛选")] }),

            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("7.3 数据可视化")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("上传趋势图 - 7天/30天上传量折线图")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("文件类型分布 - 饼图展示")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("缓存命中率 - 仪表盘展示")] }),

            new Paragraph({ children: [new PageBreak()] }),

            // 8. 权限体系
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("8. 权限体系")] }),
            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("8.1 角色定义")] }),

            createTable([
                ["角色", "权限范围", "说明"],
                ["super_admin", "所有权限+用户管理+系统配置", "系统最高权限"],
                ["admin", "文件管理+IP管理+查看日志", "日常管理"],
                ["operator", "文件查看+基础操作", "有限操作"],
            ]),

            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("8.2 权限控制")] }),
            new Paragraph({ children: [new TextRun("使用RBAC(Role-Based Access Control)模型：")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("AuthMiddleware - JWT认证中间件")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("RequireRole - 角色权限中间件")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("用户模型方法 - CanManageUsers/CanManageFiles等")] }),

            new Paragraph({ children: [new PageBreak()] }),

            // 9. 实施计划
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("9. 实施计划")] }),
            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("9.1 阶段划分")] }),

            new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun("第一阶段：基础设施")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("创建项目目录结构")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("配置管理模块提取")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("数据模型定义")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("统一响应格式")] }),

            new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun("第二阶段：后端重构")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("Repository层实现")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("Service层实现")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("Handler层重构")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("Middleware添加")] }),

            new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun("第三阶段：前端重构")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("登录页面重构")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("用户管理界面")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("数据可视化集成")] }),

            new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun("第四阶段：功能增强")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("操作日志模块")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("批量操作功能")] }),
            new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("系统配置界面")] }),

            new Paragraph({ spacing: { before: 600 } }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: "文档结束", color: "666666" })]
            }),
        ]
    }]
});

Packer.toBuffer(doc).then(buffer => {
    fs.writeFileSync("c:/预备重构/tgt-imagebed-refactored/docs/项目概要文档.docx", buffer);
    console.log("文档生成成功: docs/项目概要文档.docx");
});

function createTable(data) {
    const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
    const borders = { top: border, bottom: border, left: border, right: border };

    const rows = data.map((row, index) => {
        return new TableRow({
            children: row.map(cell => {
                const cellOptions = {
                    borders,
                    width: { size: 9360 / row.length, type: WidthType.DXA },
                    shading: index === 0 ? { fill: "E8F0F8", type: ShadingType.CLEAR } : undefined,
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [new Paragraph({
                        children: [new TextRun({
                            text: cell,
                            bold: index === 0,
                            size: 22
                        })]
                    })]
                };
                return new TableCell(cellOptions);
            })
        });
    });

    return new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: data[0].map(() => Math.floor(9360 / data[0].length)),
        rows
    });
}
