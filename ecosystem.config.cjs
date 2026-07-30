# PM2 生产部署配置
# 安装 PM2: npm install -g pm2
# 启动: pm2 start ecosystem.config.cjs
# 查看: pm2 status
# 日志: pm2 logs maas-server

module.exports = {
  apps: [
    {
      name: 'maas-server',
      cwd: './server',
      script: 'npx',
      args: 'tsx src/index.ts',
      interpreter: 'none',  // 使用 npx 作为启动器
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      // 生产环境建议先编译为 JS 再用 node 运行：
      // script: 'dist/index.js',
      // 编译命令: cd server && npx tsc

      // 进程管理
      instances: 1,         // 或 'max' 使用所有 CPU
      exec_mode: 'fork',    // Fastify 用 fork 模式
      watch: false,         // 生产环境不监听文件变化
      max_memory_restart: '512M',

      // 日志
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/maas-server-error.log',
      out_file: './logs/maas-server-out.log',
      merge_logs: true,

      // 自动重启
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,

      // 优雅关闭
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 10000,
    },
    {
      name: 'maas-client',
      cwd: './client',
      script: 'npx',
      args: 'next start -p 3000',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      },
      // 需要先构建: cd client && npm run build
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/maas-client-error.log',
      out_file: './logs/maas-client-out.log',
      merge_logs: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'maas-admin',
      cwd: './admin-client',
      script: 'npx',
      args: 'next start -p 3002',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      },
      // 需要先构建: cd admin-client && npm run build
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/maas-admin-error.log',
      out_file: './logs/maas-admin-out.log',
      merge_logs: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
