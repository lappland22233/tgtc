# 数据库迁移指南

## 📋 概述

本指南帮助您将旧版本的TG图床数据迁移到新的数据库结构，新增 `delete_reason` 字段用于记录文件删除原因。

## ✨ 新增功能

**delete_reason 字段**:
- **类型**: VARCHAR(500)
- **说明**: 记录文件被删除的原因
- **默认值**: NULL（为空）
- **位置**: files 表中 status 字段之后

## 🚀 迁移方法

### 方法1：使用Python脚本（推荐）

#### Linux/Mac

```bash
# 1. 确保已安装依赖
pip install pymysql

# 2. 执行迁移脚本
python3 migrate.py
```

#### Windows

```cmd
REM 1. 安装依赖
pip install pymysql

REM 2. 执行迁移脚本
python migrate.py
```

### 方法2：使用Shell脚本（Linux/Mac）

```bash
# 1. 确保已配置 data.json
cp data.json.example data.json
nano data.json

# 2. 执行迁移脚本
chmod +x migrate-data.sh
./migrate-data.sh
```

### 方法3：使用批处理脚本（Windows）

```cmd
REM 1. 确保已配置 data.json
copy data.json.example data.json
notepad data.json

REM 2. 执行迁移脚本
migrate-data.bat
```

### 方法4：手动执行SQL

```sql
-- 直接在数据库中执行
ALTER TABLE files
ADD COLUMN delete_reason VARCHAR(500) DEFAULT NULL
COMMENT '删除原因'
AFTER status;
```

## 📊 迁移流程

### 迁移前检查

- [ ] 确认 `data.json` 配置文件存在
- [ ] 确认数据库连接信息正确
- [ ] 确认 `files` 表已存在
- [ ] 确认有足够的磁盘空间用于备份
- [ ] （可选）备份整个数据库

### 执行迁移

1. **连接测试** - 脚本会测试数据库连接
2. **字段检测** - 检查是否需要迁移
3. **数据备份** - 自动创建 `.sql` 备份文件
4. **字段添加** - 添加 `delete_reason` 字段
5. **验证成功** - 确认字段已添加
6. **显示结果** - 显示表结构和数据统计

### 迁移后验证

- [ ] 检查备份文件已创建
- [ ] 检查 `delete_reason` 字段存在
- [ ] 检查现有数据保持不变
- [ ] 测试应用程序删除功能
- [ ] 验证新字段可正常写入

## 🔄 迁移脚本说明

### migrate.py (Python脚本）

**优点**:
- ✅ 跨平台支持（Windows/Linux/Mac）
- ✅ 详细的错误处理
- ✅ 自动备份数据库
- ✅ 友好的输出信息
- ✅ 失败时自动回滚

**缺点**:
- 需要 Python 3.x
- 需要 pymysql 库

### migrate-data.sh (Shell脚本）

**优点**:
- ✅ 不需要额外依赖
- ✅ 直接使用 MySQL 命令
- ✅ 自动创建备份
- ✅ 失败时自动恢复

**缺点**:
- 仅支持 Linux/Mac
- 依赖 bash 和 mysqldump

### migrate-data.bat (批处理脚本）

**优点**:
- ✅ 不需要额外依赖
- ✅ 直接使用 MySQL 命令
- ✅ 自动创建备份
- ✅ 失败时自动恢复

**缺点**:
- 仅支持 Windows
- 依赖 PowerShell

## 📁 备份文件

迁移脚本会自动创建备份文件，命名格式：

```
backup_YYYYMMDD_HHMMSS.sql
```

示例：
```
backup_20260216_183045.sql
```

## 🔙 回滚方法

如果迁移后出现问题，可以使用备份回滚：

### 方法1：使用备份文件

```bash
# Linux/Mac
mysql -h localhost -P 3306 -u username -p database_name < backup_20260216_183045.sql

# Windows
mysql -h localhost -P 3306 -u username -p database_name < backup_20260216_183045.sql
```

### 方法2：删除新增字段

```sql
-- 删除 delete_reason 字段
ALTER TABLE files DROP COLUMN delete_reason;
```

## 📋 迁移后的影响

### 应用程序影响

- **旧数据**: 现有文件的 `delete_reason` 字段为 NULL
- **新数据**: 删除文件时可以填写删除原因
- **API影响**: 新增参数需要 `delete_reason`

### 代码更新

需要更新的代码文件：

1. **admin/api.go**
   - `DeleteHandler` 需要接收 `delete_reason`
   - 数据库更新时写入删除原因

2. **bot/database.py**
   - `delete_file_by_path` 函数需要更新

3. **前端界面**
   - 删除确认对话框添加"删除原因"输入框

### 示例代码更新

```go
// admin/api.go
type DeleteRequest struct {
    Path        string `json:"path"`
    Reason      string `json:"reason"`  // 新增
}
```

```python
// bot/database.py
def delete_file_by_path(self, random_path: str, reason: str = "") -> Tuple[bool, str]:
    # 使用 reason 参数
    pass
```

## ✅ 验证清单

迁移完成后，请验证以下项目：

### 数据库验证

```sql
-- 检查字段是否存在
SHOW COLUMNS FROM files LIKE 'delete_reason';

-- 查看表结构
DESC files;

-- 查看数据统计
SELECT
    status,
    COUNT(*) as count,
    COUNT(CASE WHEN delete_reason IS NULL THEN 1 END) as no_reason
FROM files
GROUP BY status;
```

### 功能验证

- [ ] 可以正常上传文件
- [ ] 可以正常访问文件
- [ ] 删除功能正常工作
- [ ] 删除原因可以填写和保存
- [ ] 管理后台正常显示
- [ ] API 接口正常响应

## 🚨 常见问题

### Q1: 脚本提示"配置文件不存在"

**A**: 复制配置模板
```bash
cp data.json.example data.json
nano data.json  # 编辑配置
```

### Q2: 脚本提示"数据库连接失败"

**A**: 检查配置文件中的数据库信息
```json
{
  "mysql": {
    "host": "localhost",
    "port": 3306,
    "username": "your_username",
    "password": "your_password",
    "database": "your_database"
  }
}
```

### Q3: 提示"字段已存在，无需迁移"

**A**: 说明数据库已经是最新结构，无需迁移。

### Q4: 迁移后应用程序报错

**A**:
1. 检查应用程序代码是否已更新
2. 重启应用程序
3. 检查日志文件
4. 如有问题，使用备份回滚

### Q5: 备份文件创建失败

**A**:
1. 检查磁盘空间
2. 检查 mysqldump 是否已安装
3. 检查文件写入权限
4. 手动备份数据库

## 📞 技术支持

如遇到问题，请：

1. 查看迁移脚本的详细错误信息
2. 检查 MySQL 错误日志
3. 检查应用程序日志
4. 查看项目文档

## 🎯 下一步

迁移完成后：

1. ✅ 测试应用程序的所有功能
2. ✅ 更新相关文档
3. ✅ 通知团队成员数据库结构变更
4. ✅ 更新开发环境
5. ✅ 部署到生产环境

---

**迁移脚本文件**:
- `migrate.py` - Python脚本（推荐）
- `migrate-data.sh` - Shell脚本
- `migrate-data.bat` - 批处理脚本

**建议使用**: Python脚本 `migrate.py`
