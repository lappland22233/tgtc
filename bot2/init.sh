#!/bin/bash

# Bot2 初始化脚本

set -e

cd "$(dirname "$0")"

echo "=========================================="
echo "Bot2 初始化脚本"
echo "=========================================="
echo ""

# 检查 Python3
if ! command -v python3 &> /dev/null; then
    echo "❌ 错误: 未找到 python3"
    echo "请先安装 Python3"
    exit 1
fi
echo "✅ Python3 检查通过"

# 检查 MySQL
if ! command -v mysql &> /dev/null; then
    echo "⚠️  警告: 未找到 mysql 客户端"
    echo "数据库初始化可能需要手动执行"
fi

# 检查配置文件
if [ ! -f "data.json" ]; then
    echo ""
    echo "📝 创建配置文件..."
    if [ -f "data.json.example" ]; then
        cp data.json.example data.json
        echo "✅ 已创建 data.json"
        echo ""
        echo "⚠️  请编辑 data.json 填写以下配置："
        echo "   - telegram.bot_token"
        echo "   - mysql.host, mysql.username, mysql.password, mysql.database"
        echo "   - admin.user_ids"
        echo "   - server.base_url"
        echo ""
        read -p "按回车键继续（编辑完配置后）..."
    else
        echo "❌ 错误: 找不到 data.json.example"
        exit 1
    fi
else
    echo "✅ 配置文件已存在"
fi

# 验证配置文件
if [ -f "data.json" ]; then
    echo ""
    echo "🔍 验证配置文件..."

    # 检查必要的配置项
    if python3 -c "
import json
import sys
with open('data.json', 'r') as f:
    config = json.load(f)
    required = ['telegram.bot_token', 'telegram.bot_api_url', 'mysql.host',
                'mysql.username', 'mysql.password', 'mysql.database',
                'admin.user_ids', 'server.listen_addr', 'server.base_url']
    for key in required:
        keys = key.split('.')
        val = config
        for k in keys:
            if k not in val:
                print(f'Missing: {key}')
                sys.exit(1)
            val = val[k]
        if val == 'YOUR_BOT_TOKEN' or val == 'your_password':
            print(f'需要修改: {key}')
            sys.exit(1)
    print('配置验证通过')
" 2>/dev/null; then
        echo "✅ 配置文件验证通过"
    else
        echo ""
        echo "⚠️  配置文件验证失败，请检查："
        echo "   - 是否填写了 bot_token"
        echo "   - 是否填写了 mysql 密码"
        echo "   - 是否修改了 admin.user_ids"
        echo ""
        read -p "是否继续？(y/n): " confirm
        if [[ ! $confirm =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
fi

# 创建虚拟环境
echo ""
echo "🐍 创建 Python 虚拟环境..."

if [ -d "venv" ]; then
    echo "⚠️  虚拟环境已存在，跳过创建"
else
    python3 -m venv venv
    echo "✅ 虚拟环境创建完成"
fi

# 激活虚拟环境
source venv/bin/activate

# 升级 pip
echo "   升级 pip..."
pip install --upgrade pip --quiet

# 安装依赖
echo ""
echo "📦 安装 Python 依赖..."

echo "   安装 Bot 依赖..."
pip install -r requirements.txt --quiet

echo "   安装 HTTP Server 依赖..."
pip install -r requirements_server.txt --quiet

echo "✅ 依赖安装完成"

# 创建必要目录
echo ""
echo "📁 创建必要目录..."

mkdir -p /data/cache
mkdir -p logs

echo "✅ 目录创建完成"

# 设置权限
echo ""
echo "🔐 设置目录权限..."

chmod 755 /data/cache
chmod 755 logs

echo "✅ 权限设置完成"

# 数据库初始化
echo ""
echo "=========================================="
echo "📊 数据库初始化"
echo "=========================================="
echo ""
echo "数据库将创建："
DB_NAME=$(python3 -c "import json; print(json.load(open('data.json'))['mysql']['database'])")
DB_USER=$(python3 -c "import json; print(json.load(open('data.json'))['mysql']['username'])")
echo "  - 数据库名: $DB_NAME"
echo "  - 用户名: $DB_USER"
echo ""
echo "选择初始化方式："
echo "  1) 自动初始化（需要 MySQL root 密码）"
echo "  2) 手动初始化（需要手动执行 SQL）"
echo "  3) 跳过数据库初始化"
echo ""
read -p "请选择 [1/2/3]: " db_choice

case $db_choice in
    1)
        echo ""
        echo "🚀 执行自动数据库初始化..."
        chmod +x init_database.sh
        ./init_database.sh
        ;;
    2)
        echo ""
        echo "📝 手动数据库初始化步骤："
        echo ""
        echo "1. 登录 MySQL："
        echo "   mysql -u root -p"
        echo ""
        echo "2. 执行 SQL 文件："
        echo "   source init_db.sql"
        echo ""
        echo "或者直接执行："
        echo "   mysql -u root -p < init_db.sql"
        echo ""
        read -p "数据库初始化完成后按回车键继续..."
        ;;
    3)
        echo ""
        echo "⏭️  跳过数据库初始化"
        echo ""
        echo "如需手动初始化，请运行："
        echo "  ./init_database.sh"
        echo ""
        ;;
    *)
        echo ""
        echo "❌ 无效选择，跳过数据库初始化"
        ;;
esac

# 测试数据库连接
echo ""
echo "🔍 测试数据库连接..."

if python3 -c "
import json
import pymysql
with open('data.json', 'r') as f:
    config = json.load(f)
try:
    conn = pymysql.connect(
        host=config['mysql']['host'],
        port=config['mysql']['port'],
        user=config['mysql']['username'],
        password=config['mysql']['password'],
        database=config['mysql']['database'],
        charset='utf8mb4'
    )
    conn.close()
    print('数据库连接成功')
except Exception as e:
    print(f'数据库连接失败: {e}')
    exit(1)
" 2>/dev/null; then
    echo "✅ 数据库连接成功"
else
    echo ""
    echo "⚠️  数据库连接失败，请检查配置"
    echo "   - 数据库是否已初始化"
    echo "   - MySQL 是否正在运行"
    echo "   - 用户名密码是否正确"
    echo "   - 数据库名称是否存在"
    echo ""
    read -p "是否继续？(y/n): " confirm
    if [[ ! $confirm =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# 退出虚拟环境
deactivate

# 初始化完成
echo ""
echo "=========================================="
echo "✅ Bot2 初始化完成！"
echo "=========================================="
echo ""
echo "启动服务："
echo "  ./run.sh"
echo ""
echo "查看日志："
echo "  tail -f logs/bot.log"
echo "  tail -f logs/server.log"
echo ""
echo "停止服务："
echo "  ./stop.sh"
echo ""
echo "=========================================="
