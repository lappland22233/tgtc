-- TG 图床 Go 版本数据库初始化/兼容迁移脚本
-- 说明：
-- 1) 使用 IF NOT EXISTS 保留已有数据
-- 2) 兼容 MySQL 5.7：通过 information_schema 检查后再执行 ADD COLUMN

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
    cache_expires_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
-- MySQL 5.7 不支持 `ADD COLUMN IF NOT EXISTS`，因此使用条件 SQL
SET @file_name_col_exists := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'files'
      AND COLUMN_NAME = 'file_name'
);
SET @file_name_col_sql := IF(
    @file_name_col_exists = 0,
    'ALTER TABLE files ADD COLUMN file_name VARCHAR(500) DEFAULT NULL AFTER file_size',
    'SELECT 1'
);
PREPARE stmt FROM @file_name_col_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @delete_reason_col_exists := (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'files'
      AND COLUMN_NAME = 'delete_reason'
);
SET @delete_reason_col_sql := IF(
    @delete_reason_col_exists = 0,
    'ALTER TABLE files ADD COLUMN delete_reason VARCHAR(500) DEFAULT NULL AFTER status',
    'SELECT 1'
);
PREPARE stmt FROM @delete_reason_col_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
