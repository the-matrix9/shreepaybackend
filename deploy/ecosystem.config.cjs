// pm2 start deploy/ecosystem.config.cjs   (run from /var/www/shreepay/backend)
module.exports = {
  apps: [
    {
      name: 'shreepay-api',
      cwd: '/var/www/shreepay/backend',
      script: 'dist/server.js',
      instances: 2, // cluster mode: use "max" on bigger servers. Requires REDIS_URL for shared rate limits.
      exec_mode: 'cluster',
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' }, // everything else is read from backend/.env
    },
  ],
};
