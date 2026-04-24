/**
 * TG图床 认证模块
 * 管理登录、登出、Token刷新等功能
 */

const Auth = {
    // API基础URL
    API_BASE: '',

    /**
     * 获取访问令牌
     */
    getAccessToken() {
        return localStorage.getItem('access_token');
    },

    /**
     * 获取刷新令牌
     */
    getRefreshToken() {
        return localStorage.getItem('refresh_token');
    },

    /**
     * 获取当前用户信息
     */
    getCurrentUser() {
        const userStr = localStorage.getItem('user');
        return userStr ? JSON.parse(userStr) : null;
    },

    /**
     * 检查是否已登录
     */
    isLoggedIn() {
        return !!this.getAccessToken();
    },

    /**
     * 检查用户是否有指定角色
     */
    hasRole(role) {
        const user = this.getCurrentUser();
        if (!user) return false;

        const roleHierarchy = {
            'super_admin': 3,
            'admin': 2,
            'operator': 1
        };

        const userLevel = roleHierarchy[user.role] || 0;
        const requiredLevel = roleHierarchy[role] || 0;

        return userLevel >= requiredLevel;
    },

    /**
     * 检查是否可以管理用户
     */
    canManageUsers() {
        return this.hasRole('super_admin');
    },

    /**
     * 登录
     */
    async login(username, password) {
        const response = await fetch(`${this.API_BASE}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || data.message || '登录失败');
        }

        // 保存token
        this.setTokens(data.data.access_token, data.data.refresh_token);
        this.setUser(data.data.user);

        return data.data;
    },

    /**
     * 登出
     */
    async logout() {
        try {
            await fetch(`${this.API_BASE}/api/auth/logout`, {
                method: 'POST',
                headers: this.getAuthHeaders()
            });
        } catch (e) {
            console.error('登出请求失败:', e);
        }

        this.clearAuth();
    },

    /**
     * 刷新令牌
     */
    async refreshToken() {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) {
            throw new Error('没有刷新令牌');
        }

        const response = await fetch(`${this.API_BASE}/api/auth/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ refresh_token: refreshToken })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            this.clearAuth();
            throw new Error('令牌刷新失败，请重新登录');
        }

        // 更新token
        this.setTokens(data.data.access_token, data.data.refresh_token);

        return data.data;
    },

    /**
     * 获取当前用户信息
     */
    async getMe() {
        const response = await fetch(`${this.API_BASE}/api/auth/me`, {
            method: 'GET',
            headers: this.getAuthHeaders()
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error('获取用户信息失败');
        }

        return data.data;
    },

    /**
     * 发送带认证的请求
     */
    async request(url, options = {}) {
        const token = this.getAccessToken();

        if (!options.headers) {
            options.headers = {};
        }

        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }

        let response = await fetch(`${this.API_BASE}${url}`, options);

        // 如果是401，尝试刷新token后重试
        if (response.status === 401) {
            try {
                await this.refreshToken();
                options.headers['Authorization'] = `Bearer ${this.getAccessToken()}`;
                response = await fetch(`${this.API_BASE}${url}`, options);
            } catch (e) {
                // 刷新失败，跳转到登录页
                this.clearAuth();
                window.location.href = 'login.html';
                throw e;
            }
        }

        const data = await response.json();

        if (!response.ok || !data.success) {
            throw new Error(data.error || data.message || '请求失败');
        }

        return data;
    },

    /**
     * 保存令牌
     */
    setTokens(accessToken, refreshToken) {
        localStorage.setItem('access_token', accessToken);
        localStorage.setItem('refresh_token', refreshToken);
    },

    /**
     * 保存用户信息
     */
    setUser(user) {
        localStorage.setItem('user', JSON.stringify(user));
    },

    /**
     * 获取认证头
     */
    getAuthHeaders() {
        const token = this.getAccessToken();
        const headers = {
            'Content-Type': 'application/json'
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        return headers;
    },

    /**
     * 清除认证信息
     */
    clearAuth() {
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        localStorage.removeItem('user');
    }
};

// 导出给全局使用
window.Auth = Auth;
