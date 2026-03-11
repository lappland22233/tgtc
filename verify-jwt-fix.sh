#!/bin/bash

# JWT 认证修复验证脚本

echo "======================================"
echo "JWT 认证修复验证"
echo "======================================"
echo ""

# 检查 Go 环境
echo "1. 检查 Go 环境..."
if ! command -v go &> /dev/null; then
    echo "❌ 错误：未找到 Go 命令"
    exit 1
fi
echo "✅ Go 版本：$(go version)"
echo ""

# 检查依赖
echo "2. 检查项目依赖..."
if [ ! -f "go.mod" ]; then
    echo "❌ 错误：未找到 go.mod 文件"
    exit 1
fi
echo "✅ go.mod 存在"
echo ""

# 编译项目
echo "3. 编译项目..."
go build -o tg-imagebed-test main.go
if [ $? -ne 0 ]; then
    echo "❌ 编译失败"
    exit 1
fi
echo "✅ 编译成功"
echo ""

# 检查代码关键点
echo "4. 检查代码修改..."
echo ""

echo "  检查点 1: initJWTSecret() 函数是否存在..."
if grep -q "func initJWTSecret()" main.go; then
    echo "  ✅ initJWTSecret() 函数已实现"
else
    echo "  ❌ initJWTSecret() 函数未找到"
fi

echo "  检查点 2: /admin.html 是否移除了 JWT 中间件..."
if grep -q 'mux.HandleFunc("/admin.html", func(w http.ResponseWriter, r *http.Request)' main.go; then
    echo "  ✅ /admin.html 已移除 JWT 中间件"
else
    echo "  ❌ /admin.html 仍然使用 JWT 中间件"
fi

echo "  检查点 3: jwt_secret.key 文件引用..."
if grep -q 'jwt_secret.key' main.go; then
    echo "  ✅ jwt_secret.key 文件路径已配置"
else
    echo "  ❌ jwt_secret.key 文件路径未配置"
fi

echo "  检查点 4: .gitignore 是否包含 *.key..."
if grep -q '\*.key' .gitignore; then
    echo "  ✅ .gitignore 已包含 *.key 规则"
else
    echo "  ⚠️  .gitignore 未包含 *.key 规则（建议添加）"
fi

echo ""
echo "5. 清理测试文件..."
rm -f tg-imagebed-test
echo "✅ 清理完成"
echo ""

echo "======================================"
echo "验证完成！"
echo "======================================"
echo ""
echo "📋 下一步操作："
echo "1. 运行 './tg-imagebed' 启动服务"
echo "2. 访问 http://localhost:8080/admin.html 测试登录页面"
echo "3. 使用 API Key 登录并获取 Token"
echo "4. 重启服务，验证 Token 是否仍然有效"
echo ""
