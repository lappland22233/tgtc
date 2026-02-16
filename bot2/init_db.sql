-- =============================================
-- Bot2 数据库表初始化脚本
-- 在已有数据库中创建表结构
-- =============================================

-- 创建白名单表
CREATE TABLE IF NOT EXISTS whitelist (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT '主键 ID',
    tg_user_id BIGINT NOT NULL UNIQUE COMMENT 'Telegram 用户 ID',
    username VARCHAR(255) DEFAULT NULL COMMENT 'Telegram 用户名',
    added_by BIGINT DEFAULT NULL COMMENT '添加者用户 ID',
    added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '添加时间',
    status ENUM('active', 'removed') NOT NULL DEFAULT 'active' COMMENT '状态',
    INDEX idx_tg_user_id (tg_user_id),
    INDEX idx_status (status),
    INDEX idx_added_at (added_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='白名单表';

-- 创建文件表
CREATE TABLE IF NOT EXISTS files (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT '主键 ID',
    random_path VARCHAR(32) NOT NULL UNIQUE COMMENT '随机访问路径',
    file_id VARCHAR(255) NOT NULL COMMENT 'Telegram 文件 ID',
    file_unique_id VARCHAR(255) NOT NULL COMMENT 'Telegram 文件唯一 ID',
    mime_type VARCHAR(100) DEFAULT NULL COMMENT 'MIME 类型',
    file_size INT DEFAULT NULL COMMENT '文件大小（字节）',
    file_name VARCHAR(500) DEFAULT NULL COMMENT '文件名',
    upload_ip VARBINARY(16) DEFAULT NULL COMMENT '上传者 IP',
    edge_ip VARBINARY(16) DEFAULT NULL COMMENT '边缘节点 IP',
    tg_user_id BIGINT DEFAULT NULL COMMENT 'Telegram 用户 ID',
    username VARCHAR(255) DEFAULT NULL COMMENT 'Telegram 用户名',
    status ENUM('normal', 'deleted') NOT NULL DEFAULT 'normal' COMMENT '状态',
    delete_reason VARCHAR(500) DEFAULT NULL COMMENT '删除原因',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    last_accessed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最后访问时间',
    cache_expires_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '缓存过期时间',
    INDEX idx_random_path (random_path),
    INDEX idx_file_unique_id (file_unique_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    INDEX idx_cache_expires (cache_expires_at),
    INDEX idx_tg_user_id (tg_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文件表';

-- 创建 IP 封禁表
CREATE TABLE IF NOT EXISTS banned_ips (
    id INT AUTO_INCREMENT PRIMARY KEY COMMENT '主键 ID',
    ip VARBINARY(16) NOT NULL UNIQUE COMMENT 'IP 地址（二进制存储）',
    banned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '封禁时间',
    reason VARCHAR(500) DEFAULT NULL COMMENT '封禁原因',
    INDEX idx_ip (ip),
    INDEX idx_banned_at (banned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='IP 封禁表';

-- =============================================
-- 插入默认管理员到白名单
-- 注意：需要将下面的 123456789 替换为你的实际 Telegram 用户 ID
-- =============================================

INSERT IGNORE INTO whitelist (tg_user_id, username, added_by, status)
VALUES (123456789, 'admin', 0, 'active');

-- =============================================
-- 验证表是否创建成功
-- =============================================

SELECT 'Tables initialized successfully!' AS '';
SELECT 'whitelist table:' AS '';
SELECT COUNT(*) as total_users FROM whitelist;

SELECT 'files table:' AS '';
SELECT COUNT(*) as total_files FROM files;

SELECT 'banned_ips table:' AS '';
SELECT COUNT(*) as total_banned FROM banned_ips;

SELECT 'Please remember to update the default admin user ID (123456789) in whitelist table!' AS '';
