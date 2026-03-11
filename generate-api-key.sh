#!/bin/bash

# 生成随机 API Key 的脚本

echo "======================================"
echo "  TG图床 - API Key 生成工具"
echo "======================================"
echo ""

# 生成 32 字节的随机十六进制字符串（64 个字符）
API_KEY=$(openssl rand -hex 32)

echo "生成的新 API Key:"
echo ""
echo "  $API_KEY"
echo ""
echo "======================================"
echo "使用说明："
echo "1. 复制上面的 API Key"
echo "2. 粘贴到 data.json 文件的 api_keys 数组中"
echo "3. 重启服务使其生效"
echo ""
echo "示例配置："
echo '{'
echo '  "api_keys": ['
echo "    \"$API_KEY\""
echo '  ]'
echo '}'
echo "======================================"
