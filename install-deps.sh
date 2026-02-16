#!/bin/bash

# TG 图床上传工具 - 依赖安装脚本 (Linux/Mac)

echo "=========================================="
echo "  TG 图床 - 依赖安装脚本"
echo "=========================================="
echo ""

# 检查 Python
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] 未找到 Python3，请先安装 Python 3.7+"
    exit 1
fi

echo "[INFO] Python 版本: $(python3 --version)"

# 检查 pip
if ! python3 -m pip --version &> /dev/null; then
    echo "[WARN] pip 未安装，尝试安装..."
    python3 -m ensurepip --default-pip
fi

# 安装依赖
echo ""
echo "[INFO] 安装依赖..."

# 使用清华镜像源
echo "[INFO] 使用清华镜像源..."

# 安装 requests
echo "[INFO] 安装 requests..."
python3 -m pip install requests -i https://pypi.tuna.tsinghua.edu.cn/simple

if [ $? -ne 0 ]; then
    echo "[WARN] 清华源失败，尝试阿里云镜像源..."
    python3 -m pip install requests -i https://mirrors.aliyun.com/pypi/simple/
fi

if [ $? -ne 0 ]; then
    echo "[WARN] 阿里源失败，尝试官方源..."
    python3 -m pip install requests
fi

# 安装 PyQt5 (GUI需要)
echo ""
echo "[INFO] 安装 PyQt5 (用于GUI版本)..."
python3 -m pip install PyQt5 -i https://pypi.tuna.tsinghua.edu.cn/simple

if [ $? -ne 0 ]; then
    echo "[WARN] 清华源失败，尝试阿里云镜像源..."
    python3 -m pip install PyQt5 -i https://mirrors.aliyun.com/pypi/simple/
fi

if [ $? -ne 0 ]; then
    echo "[WARN] 阿里源失败，尝试官方源..."
    python3 -m pip install PyQt5
fi

echo ""
echo "=========================================="
echo "[SUCCESS] 依赖安装完成"
echo "=========================================="
echo ""
echo "使用方法:"
echo "  命令行版本: python3 upload-cli.py <文件>"
echo "  GUI版本:   python3 upload-gui.py"
echo ""
