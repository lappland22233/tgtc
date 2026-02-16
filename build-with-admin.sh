#!/bin/bash

# TG图床后台管理版 - 编译脚本

echo "=========================================="
echo "  TG图床后台管理版 - 编译脚本"
echo "=========================================="
echo ""

# 检查 Go 环境
if ! command -v go &> /dev/null; then
    echo "[ERROR] 未找到 Go 环境，请先安装 Go"
    echo "下载地址: https://golang.org/dl/"
    exit 1
fi

echo "[INFO] Go 版本: $(go version)"
echo ""

# 编译程序
echo "[INFO] 开始编译..."
go build -o tg-imagebed

if [ $? -eq 0 ]; then
    echo "[SUCCESS] 编译成功！"
    echo ""
    echo "生成的可执行文件: tg-imagebed"
    echo ""
    echo "运行程序:"
    echo "  ./tg-imagebed"
    echo ""
    echo "访问管理后台:"
    echo "  http://your-domain:8080/admin.html"
    echo ""
    echo "默认认证信息:"
    echo "  用户名: admin"
    echo "  密码: changeme123"
    echo ""
    echo "⚠️  重要提示:"
    echo "  1. 请务必修改 admin/auth.go 中的默认密码"
    echo "  2. 生产环境请使用 HTTPS"
    echo "  3. 查看 ADMIN_README.md 了解详细功能"
else
    echo "[ERROR] 编译失败"
    exit 1
fi

echo "=========================================="
