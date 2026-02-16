# 后台管理系统更新日志

## v1.0.0 - 2026-02-16

### 新功能

- ✨ 完整的后台管理系统
  - 统计信息仪表板
  - 文件列表管理（分页显示）
  - IP搜索功能
  - IP封禁/解封管理
  - 文件删除功能

### 文件结构重组

```
TG图床/
├── admin/                    # 后台管理模块
│   ├── index.html           # 前端界面
│   ├── api.go              # API接口
│   ├── auth.go             # 认证中间件
│   └── README.md           # 模块文档
├── main.go                 # 主程序（已更新）
├── ADMIN_README.md         # 完整使用文档
├── ADMIN_CHANGELOG.md       # 更新日志（本文件）
├── build-with-admin.sh     # Linux/Mac编译脚本
└── build-with-admin.bat    # Windows编译脚本
```

### 主要变更

1. **模块化设计**
   - 将后台管理功能拆分为独立的 `admin` 包
   - API 接口统一在 `admin/api.go`
   - 认证中间件在 `admin/auth.go`

2. **包结构**
   - 模块名: `tg-imagebed`
   - 后台包: `admin`
   - 导入方式: `tg-imagebed/admin`

3. **路由更新**
   - `/admin.html` → `admin/index.html`
   - 所有API端点保持不变
   - 认证方式保持一致

### 安全特性

- 🔐 HTTP Basic Auth 认证（默认）
- 🔑 Token 认证（可选）
- 🌐 IP 白名单（可选）
- ⏱️ Constant-time 比较防止时序攻击

### 认证配置

默认凭据（请务必修改）：
- 用户名: `admin`
- 密码: `changeme123`

修改位置: `admin/auth.go`

### API 端点

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/admin.html` | GET | 需要 | 管理后台界面 |
| `/api/stats` | GET | 需要 | 获取统计信息 |
| `/api/files` | GET | 需要 | 获取文件列表 |
| `/api/banned` | GET | 需要 | 获取封禁IP列表 |
| `/api/ban` | POST | 需要 | 封禁IP |
| `/api/unban` | POST | 需要 | 解封IP |
| `/api/delete` | POST | 需要 | 删除文件 |

### 前端功能

#### 统计面板
- 总文件数
- 今日上传数
- 今日访问数
- 封禁IP数量
- 缓存命中率

#### 文件管理
- 表格展示（每页20条）
- 分页浏览
- IP搜索
- 在线预览
- 删除文件
- 直接封禁IP

#### IP管理
- 封禁IP（可填写原因）
- 解封IP
- 查看封禁列表
- 一键操作

### 编译和运行

**Linux/Mac:**
```bash
chmod +x build-with-admin.sh
./build-with-admin.sh
./tg-imagebed
```

**Windows:**
```cmd
build-with-admin.bat
tg-imagebed.exe
```

**手动编译:**
```bash
go build -o tg-imagebed
```

### 访问管理后台

```
http://your-domain:8080/admin.html
```

输入认证凭据后即可访问管理界面。

### 文档

- **使用指南**: `ADMIN_README.md`
- **模块文档**: `admin/README.md`
- **更新日志**: `ADMIN_CHANGELOG.md` (本文件)

### 注意事项

1. ⚠️ **生产环境必须修改默认密码**
2. 🔒 **建议使用 HTTPS**
3. 🛡️ **考虑启用 IP 白名单**
4. 💾 **定期备份数据库**
5. 📊 **监控访问日志**

### 技术栈

- **后端**: Go 1.19+
- **前端**: HTML5 + CSS3 + JavaScript (Vanilla)
- **数据库**: MySQL
- **认证**: HTTP Basic Auth / Bearer Token
- **依赖**: github.com/go-sql-driver/mysql

### 待办事项

- [ ] 添加操作日志记录
- [ ] 支持批量操作
- [ ] 添加文件批量删除
- [ ] 支持IP封禁定时解封
- [ ] 添加更多统计图表
- [ ] 支持多语言
- [ ] 优化大文件列表性能
- [ ] 添加 WebSocket 实时更新

### 已知问题

无

### 反馈与支持

如有问题或建议，请通过以下方式联系：
- 提交 Issue
- 发送邮件
- 加入讨论组

---

**更新日期**: 2026-02-16
**版本**: v1.0.0
