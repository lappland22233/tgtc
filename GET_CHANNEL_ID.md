# 如何获取 Telegram 群组/频道 ID

## 方法一：使用 Bot API（推荐）

### 1. 创建并配置 Bot

如果您还没有 Bot，请先创建：

1. 在 Telegram 中搜索 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot` 创建新 Bot
3. 按照提示设置 Bot 名称和用户名
4. 保存获得的 **Bot Token**

### 2. 将 Bot 添加到群组/频道

**对于群组：**
1. 进入目标群组
2. 点击群组名称 → 编辑 → 成员 → 添加成员
3. 搜索您的 Bot 用户名并添加
4. 将 Bot 设置为 **管理员**（需要发送消息权限）

**对于频道：**
1. 进入目标频道
2. 点击频道名称 → 管理员 → 添加管理员
3. 搜索您的 Bot 用户名并添加
4. 确保给予 **发送消息** 权限

### 3. 获取群组/频道 ID

1. 在您添加了 Bot 的群组/频道中发送任意消息
2. 在浏览器中访问（替换 YOUR_BOT_TOKEN）：
   ```
   https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
   ```
3. 在返回的 JSON 中查找 `"chat"` 部分，您会看到类似：
   ```json
   {
     "chat": {
       "id": -1001234567890,
       "title": "我的图床群组",
       "type": "supergroup"
     }
   }
   ```
4. `"id"` 的值就是您的群组/频道 ID（**注意：是负数**）

---

## 方法二：使用第三方 Bot（快速获取）

1. 在 Telegram 中搜索 [@GetMyIdBot](https://t.me/GetMyIdBot) 或 [@userinfobot](https://t.me/userinfobot)
2. 将 Bot **转发** 或 **邀请** 到目标群组/频道
3. Bot 会显示群组/频道 ID

---

## 方法三：使用 Web 版 Telegram

1. 在浏览器中打开 [web.telegram.org](https://web.telegram.org)
2. 进入目标群组/频道
3. 查看浏览器地址栏，URL 中包含 ID 信息：
   ```
   https://web.telegram.org/k/#-1001234567890
   ```
   最后的数字就是群组/频道 ID

---

## 配置示例

### 群组配置

```json
{
  "telegram": {
    "bot_token": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "channel_id": "-1001234567890"
  }
}
```

### 频道配置

```json
{
  "telegram": {
    "bot_token": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "channel_id": "-1009876543210"
  }
}
```

---

## 重要提示

### ⚠️ 常见错误

1. **ID 格式错误**
   - ❌ 错误: `"1001234567890"` （正数）
   - ✅ 正确: `"-1001234567890"` （负数，带引号）

2. **Bot 权限不足**
   - Bot 必须是群组/频道的管理员
   - Bot 需要有"发送消息"权限

3. **Bot 未添加到群组/频道**
   - 确保已将 Bot 添加到配置的群组/频道中

### ✅ 验证配置

配置完成后，可以使用 curl 测试：

```bash
curl -X POST \
  "https://api.telegram.org/botYOUR_BOT_TOKEN/sendMessage" \
  -d "chat_id=-1001234567890" \
  -d "text=测试消息"
```

如果成功，您会在群组/频道中看到 "测试消息"。

---

## 不同类型的 ID

| 类型 | ID 格式 | 示例 | 说明 |
|------|---------|------|------|
| 用户 ID | 正整数 | `123456789` | 个人用户 |
| 群组 ID | 负整数 | `-1001234567890` | Supergroup |
| 频道 ID | 负整数 | `-1009876543210` | Channel |
| 基础群组 ID | 负整数 | `-123456789` | Basic Group（已弃用） |

**注意：图床系统只支持 Supergroup 或 Channel（-100 开头的负数）**
