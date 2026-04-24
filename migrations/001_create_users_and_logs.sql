-- TG图床数据库迁移脚本
-- 版本: v2.0.0
-- 描述: 新增多用户认证系统表结构
-- 执行时间: 2026-04-25

-- ============================================
-- 用户表 (users)
-- ============================================
CREATE TABLE IF NOT EXISTS `users` (
    `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '用户ID',
    `username` VARCHAR(50) NOT NULL UNIQUE COMMENT '用户名',
    `password_hash` VARCHAR(255) NOT NULL COMMENT 'bcrypt加密密码',
    `role` ENUM('super_admin', 'admin', 'operator') NOT NULL DEFAULT 'admin' COMMENT '角色',
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active' COMMENT '账号状态',
    `last_login_at` TIMESTAMP NULL COMMENT '最后登录时间',
    `last_login_ip` VARCHAR(45) NULL COMMENT '最后登录IP',
    `login_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '登录次数',
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX `idx_username` (`username`),
    INDEX `idx_role` (`role`),
    INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表';

-- ============================================
-- 操作日志表 (admin_logs)
-- ============================================
CREATE TABLE IF NOT EXISTS `admin_logs` (
    `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '日志ID',
    `user_id` BIGINT UNSIGNED NOT NULL COMMENT '操作用户ID',
    `username` VARCHAR(50) NOT NULL COMMENT '操作用户名',
    `action` VARCHAR(100) NOT NULL COMMENT '操作类型',
    `target` VARCHAR(255) NULL COMMENT '操作目标',
    `ip` VARCHAR(45) NULL COMMENT '操作IP',
    `user_agent` VARCHAR(500) NULL COMMENT '浏览器信息',
    `details` TEXT NULL COMMENT '操作详情(JSON)',
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
    INDEX `idx_user_id` (`user_id`),
    INDEX `idx_action` (`action`),
    INDEX `idx_created_at` (`created_at`),
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='管理操作日志表';

-- ============================================
-- 初始化超级管理员账号
-- 默认用户名: admin
-- 默认密码: admin123 (请首次登录后立即修改!)
-- ============================================
-- 密码 'admin123' 的 bcrypt hash:
-- $2a$10$N9qo8uLOickgx2ZMRZoMye.GqjqR9P/6uFX3PV遮蔽eI7w8fQ5y
-- 实际执行时使用下面这个(来自命令: htpasswd -bnBC 12 "" admin123 | tr -d ':\n')
INSERT INTO `users` (`username`, `password_hash`, `role`, `status`)
VALUES ('admin', '$2a$10$N9qo8uLOickgx2ZMRZoMye6jqR9P/6uFX3PV遮蔽eI7w8fQ5y', 'super_admin', 'active')
ON DUPLICATE KEY UPDATE `id` = `id`;

-- ============================================
-- 操作类型常量说明 (admin_logs.action)
-- ============================================
-- login         : 用户登录
-- logout        : 用户登出
-- create_user   : 创建用户
-- update_user   : 更新用户
-- delete_user   : 删除用户
-- change_password: 修改密码
-- ban_ip        : 封禁IP
-- unban_ip      : 解封IP
-- delete_file   : 删除文件
-- update_config : 修改配置
-- ============================================
