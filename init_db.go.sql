-- TG 图床 Go 版本数据库初始化/兼容迁移脚本
-- 说明：
-- 1) 使用 IF NOT EXISTS 保留已有数据
-- 2) 使用 ADD COLUMN IF NOT EXISTS 进行增量字段迁移

CREATE TABLE IF NOT EXISTS files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    random_path VARCHAR(32) NOT NULL UNIQUE,
    file_id VARCHAR(255) NOT NULL,
    file_unique_id VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) DEFAULT NULL,
    file_size INT DEFAULT NULL,
    file_name VARCHAR(500) DEFAULT NULL,
    upload_ip VARBINARY(16) DEFAULT NULL,
    edge_ip VARBINARY(16) DEFAULT NULL,
    status ENUM('normal', 'deleted') NOT NULL DEFAULT 'normal',
    delete_reason VARCHAR(500) DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cache_expires_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL 10 MINUTE),
    INDEX idx_random_path (random_path),
    INDEX idx_file_unique_id (file_unique_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    INDEX idx_cache_expires (cache_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS banned_ips (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ip VARBINARY(16) NOT NULL UNIQUE,
    banned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reason VARCHAR(500) DEFAULT NULL,
    INDEX idx_ip (ip),
    INDEX idx_banned_at (banned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 增量迁移：旧库补字段（不会删除既有数据）
ALTER TABLE files
    ADD COLUMN IF NOT EXISTS file_name VARCHAR(500) DEFAULT NULL AFTER file_size,
    ADD COLUMN IF NOT EXISTS delete_reason VARCHAR(500) DEFAULT NULL AFTER status;
