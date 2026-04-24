/**
 * TG图床 用户管理模块
 */

const UserManager = {
    /**
     * 获取用户列表
     */
    async getUsers(page = 1, pageSize = 20) {
        return Auth.request(`/api/users?page=${page}&page_size=${pageSize}`);
    },

    /**
     * 创建用户
     */
    async createUser(username, password, role) {
        return Auth.request('/api/users', {
            method: 'POST',
            body: JSON.stringify({ username, password, role })
        });
    },

    /**
     * 更新用户
     */
    async updateUser(id, username, role, status) {
        return Auth.request('/api/users/update?id=' + id, {
            method: 'PUT',
            body: JSON.stringify({ id, username, role, status })
        });
    },

    /**
     * 删除用户
     */
    async deleteUser(id) {
        return Auth.request('/api/users/delete?id=' + id, {
            method: 'DELETE'
        });
    },

    /**
     * 修改密码
     */
    async changePassword(oldPassword, newPassword) {
        return Auth.request('/api/users/change-password', {
            method: 'POST',
            body: JSON.stringify({ old_password: oldPassword, new_password: newPassword })
        });
    },

    /**
     * 格式化角色显示
     */
    formatRole(role) {
        const roleMap = {
            'super_admin': '超级管理员',
            'admin': '管理员',
            'operator': '操作员'
        };
        return roleMap[role] || role;
    },

    /**
     * 获取角色颜色
     */
    getRoleColor(role) {
        const colorMap = {
            'super_admin': '#e74c3c',
            'admin': '#3498db',
            'operator': '#2ecc71'
        };
        return colorMap[role] || '#95a5a6';
    },

    /**
     * 格式化状态显示
     */
    formatStatus(status) {
        return status === 'active' ? '正常' : '禁用';
    },

    /**
     * 获取状态颜色
     */
    getStatusColor(status) {
        return status === 'active' ? '#2ecc71' : '#e74c3c';
    }
};

// 导出给全局使用
window.UserManager = UserManager;
