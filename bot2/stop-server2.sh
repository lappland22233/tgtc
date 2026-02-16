#!/bin/bash

# Server2 和 Bot 停止脚本

cd "$(dirname "$0")"

# 停止 server2
if [ -f "server2.pid" ]; then
    PID=$(cat server2.pid)
    echo "停止 server2 (PID: $PID)..."
    kill $PID 2>/dev/null
    rm server2.pid
else
    PIDS=$(pgrep -f "server2")
    if [ -n "$PIDS" ]; then
        echo "停止 server2 进程: $PIDS"
        kill $PIDS
    fi
fi

# 停止 bot
if [ -f "bot.pid" ]; then
    PID=$(cat bot.pid)
    echo "停止 bot (PID: $PID)..."
    kill $PID 2>/dev/null
    rm bot.pid
else
    PIDS=$(pgrep -f "bot.py")
    if [ -n "$PIDS" ]; then
        echo "停止 bot 进程: $PIDS"
        kill $PIDS
    fi
fi

echo "服务已停止"
