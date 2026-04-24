/**
 * TG图床 仪表盘模块
 */

const Dashboard = {
    uploadChart: null,
    fileTypeChart: null,

    /**
     * 加载统计数据
     */
    async loadStats() {
        try {
            const data = await Auth.request('/api/stats');

            document.getElementById('totalFiles').textContent = data.data.total_files || 0;
            document.getElementById('todayUploads').textContent = data.data.today_uploads || 0;
            document.getElementById('todayAccess').textContent = data.data.today_access || 0;
            document.getElementById('bannedIPs').textContent = data.data.banned_ips || 0;
        } catch (error) {
            console.error('加载统计数据失败:', error);
        }
    },

    /**
     * 初始化图表
     */
    initCharts() {
        // 上传趋势图
        const uploadCtx = document.getElementById('uploadChart').getContext('2d');
        this.uploadChart = new Chart(uploadCtx, {
            type: 'line',
            data: {
                labels: ['今天', '昨天', '前天', '3天前', '4天前', '5天前', '6天前'],
                datasets: [{
                    label: '上传数',
                    data: [0, 0, 0, 0, 0, 0, 0],
                    borderColor: '#4f78b4',
                    backgroundColor: 'rgba(79, 120, 180, 0.1)',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1
                        }
                    }
                }
            }
        });

        // 文件类型分布图
        const typeCtx = document.getElementById('fileTypeChart').getContext('2d');
        this.fileTypeChart = new Chart(typeCtx, {
            type: 'doughnut',
            data: {
                labels: ['图片', '视频', '文档', '其他'],
                datasets: [{
                    data: [0, 0, 0, 0],
                    backgroundColor: ['#4f78b4', '#2ecc71', '#e74c3c', '#95a5a6']
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        });
    },

    /**
     * 更新上传趋势图
     */
    updateUploadChart(data) {
        if (this.uploadChart) {
            this.uploadChart.data.datasets[0].data = data;
            this.uploadChart.update();
        }
    },

    /**
     * 更新文件类型分布图
     */
    updateFileTypeChart(data) {
        if (this.fileTypeChart) {
            this.fileTypeChart.data.datasets[0].data = data;
            this.fileTypeChart.update();
        }
    }
};

// 文件管理模块
const Files = {
    currentPage: 1,
    totalPages: 1,

    async loadFiles(page = 1) {
        this.currentPage = page;
        const tbody = document.getElementById('filesTableBody');
        tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">加载中...</td></tr>';

        try {
            const searchQuery = document.getElementById('searchInput')?.value || '';
            const url = `/api/files?page=${page}${searchQuery ? '&q=' + encodeURIComponent(searchQuery) : ''}`;
            const data = await Auth.request(url);

            if (data.data.files && data.data.files.length > 0) {
                this.totalPages = data.data.total_pages;
                this.renderFiles(data.data.files);
                this.updatePagination();
            } else {
                tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">暂无文件</td></tr>';
            }
        } catch (error) {
            console.error('加载文件列表失败:', error);
            tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">加载失败</td></tr>';
        }
    },

    renderFiles(files) {
        const tbody = document.getElementById('filesTableBody');
        tbody.innerHTML = files.map(file => `
            <tr>
                <td>
                    ${file.mime_type && file.mime_type.startsWith('image/')
                        ? `<img src="/${file.random_path}" style="width:60px;height:45px;object-fit:cover;border-radius:4px;">`
                        : '<div style="width:60px;height:45px;background:#f5f5f5;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#999;font-size:10px;">文件</div>'
                    }
                </td>
                <td>
                    <div style="font-family:monospace;color:#4f78b4;">${file.random_path}</div>
                    <div style="font-size:12px;color:#6b7280;">
                        ${file.file_name || '未知'} | ${(file.file_size / 1024).toFixed(2)} KB
                    </div>
                </td>
                <td><span class="ip-tag">${file.upload_ip || '-'}</span></td>
                <td>${file.created_at}</td>
                <td>
                    <span class="status-badge ${file.status === 'normal' ? 'status-normal' : 'status-deleted'}">
                        ${file.status === 'normal' ? '正常' : '已删除'}
                    </span>
                </td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="viewFile('${file.random_path}')">查看</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteFile('${file.random_path}')">删除</button>
                </td>
            </tr>
        `).join('');
    },

    updatePagination() {
        const pageInfo = document.getElementById('pageInfo');
        const prevBtn = document.getElementById('prevPageBtn');
        const nextBtn = document.getElementById('nextPageBtn');

        pageInfo.textContent = `第 ${this.currentPage} / ${this.totalPages} 页`;
        prevBtn.disabled = this.currentPage <= 1;
        nextBtn.disabled = this.currentPage >= this.totalPages;
    }
};

// 用户管理模块
const Users = {
    async loadUsers() {
        const tbody = document.getElementById('usersTableBody');
        tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">加载中...</td></tr>';

        try {
            const data = await UserManager.getUsers();
            if (data.data && data.data.length > 0) {
                this.renderUsers(data.data);
            } else {
                tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">暂无用户</td></tr>';
            }
        } catch (error) {
            console.error('加载用户列表失败:', error);
            tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">加载失败</td></tr>';
        }
    },

    renderUsers(users) {
        const tbody = document.getElementById('usersTableBody');
        const currentUser = Auth.getCurrentUser();

        tbody.innerHTML = users.map(user => `
            <tr>
                <td>${user.id}</td>
                <td>${user.username}</td>
                <td>
                    <span class="role-badge" style="background-color:${UserManager.getRoleColor(user.role)}">
                        ${UserManager.formatRole(user.role)}
                    </span>
                </td>
                <td>
                    <span class="status-badge" style="background-color:${UserManager.getStatusColor(user.status)};color:white;">
                        ${UserManager.formatStatus(user.status)}
                    </span>
                </td>
                <td>${user.last_login_at || '-'}</td>
                <td>${user.login_count}</td>
                <td>${user.created_at}</td>
                <td>
                    ${user.id !== currentUser.id ? `
                        <button class="btn btn-sm btn-secondary" onclick="editUser(${user.id})">编辑</button>
                        <button class="btn btn-sm btn-danger" onclick="deleteUser(${user.id})">删除</button>
                    ` : '<span style="color:#6b7280;">当前用户</span>'}
                </td>
            </tr>
        `).join('');
    }
};

// 操作日志模块
const Logs = {
    async loadLogs() {
        const tbody = document.getElementById('logsTableBody');
        tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">加载中...</td></tr>';

        try {
            const action = document.getElementById('logActionFilter')?.value || '';
            const url = `/api/logs${action ? '?action=' + action : ''}`;
            const data = await Auth.request(url);

            if (data.data && data.data.length > 0) {
                this.renderLogs(data.data);
            } else {
                tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">暂无日志</td></tr>';
            }
        } catch (error) {
            console.error('加载日志失败:', error);
            tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">加载失败</td></tr>';
        }
    },

    renderLogs(logs) {
        const tbody = document.getElementById('logsTableBody');
        tbody.innerHTML = logs.map(log => `
            <tr>
                <td>${log.created_at}</td>
                <td>${log.username}</td>
                <td>${this.formatAction(log.action)}</td>
                <td>${log.target || '-'}</td>
                <td>${log.ip || '-'}</td>
                <td>${log.details || '-'}</td>
            </tr>
        `).join('');
    },

    formatAction(action) {
        const actionMap = {
            'login': '登录',
            'logout': '登出',
            'create_user': '创建用户',
            'update_user': '更新用户',
            'delete_user': '删除用户',
            'change_password': '修改密码',
            'ban_ip': '封禁IP',
            'unban_ip': '解封IP',
            'delete_file': '删除文件'
        };
        return actionMap[action] || action;
    }
};

// 全局函数
function viewFile(path) {
    window.open('/' + path, '_blank');
}

async function deleteFile(path) {
    if (!confirm(`确定要删除文件 ${path} 吗？`)) return;

    const reason = prompt('请输入删除原因:');
    if (!reason) return;

    try {
        await Auth.request('/api/delete', {
            method: 'POST',
            body: JSON.stringify({ path, reason })
        });
        alert('删除成功');
        Files.loadFiles(Files.currentPage);
    } catch (error) {
        alert(error.message);
    }
}

function editUser(userId) {
    // 获取用户数据并打开编辑模态框
    const user = Users.getUserById(userId);
    if (user) {
        openUserModal(user);
    }
}

async function deleteUser(userId) {
    if (!confirm('确定要删除该用户吗？')) return;

    try {
        await UserManager.deleteUser(userId);
        alert('删除成功');
        Users.loadUsers();
    } catch (error) {
        alert(error.message);
    }
}

// 导出给全局使用
window.Dashboard = Dashboard;
window.Files = Files;
window.Users = Users;
window.Logs = Logs;
