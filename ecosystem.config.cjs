// PM2 Ecosystem Configuration for AI Therapist
// Usage: pm2 start ecosystem.config.cjs

module.exports = {
  apps: [{
    name: 'ai-therapist',
    script: './src/server/index.js',

    // Instances
    instances: 1,  // Use 'max' for cluster mode (all CPU cores)
    exec_mode: 'fork',  // Use 'cluster' if instances > 1

    // Environment
    env: {
      NODE_ENV: 'development',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },

    // Logging
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,

    // Process management
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '500M',

    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,

    // Watch and reload (disable in production)
    watch: false,
    ignore_watch: [
      'node_modules',
      'logs',
      'dist',
      '.git'
    ],

    // Restart on cron (optional - restart daily at 3 AM)
    // cron_restart: '0 3 * * *',

    // Source map support
    source_map_support: true,

    // Instance variables
    instance_var: 'INSTANCE_ID',

    // Exponential backoff restart delay
    exp_backoff_restart_delay: 100,

    // Post-deploy hooks (if using PM2 deploy)
    post_update: ['npm install', 'npm run build']
  }]
};
