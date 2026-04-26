/**
 * PM2 entry for the deploy queue (HTTP API + single-threaded worker loop).
 *
 * Install on server (once):
 *   cd /opt/connectcomms/app/ops/deploy-queue
 *   pnpm install
 *   pnpm run build
 *   sudo mkdir -p /var/log/connect-deploys && sudo chown "$USER" /var/log/connect-deploys
 *
 * Env file example: /opt/connectcomms/env/.env.deploy-queue
 *   DEPLOY_QUEUE_TOKEN=...
 *   DEPLOY_REPO_ROOT=/opt/connectcomms/app
 *
 * Start (export secrets first — PM2 core does not load dotenv files):
 *   set -a && source /opt/connectcomms/env/.env.deploy-queue && set +a && \\
 *     pm2 start /opt/connectcomms/app/ops/deploy-queue/ecosystem.config.cjs
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: "connect-deploy-worker",
      cwd: "/opt/connectcomms/app/ops/deploy-queue",
      script: "dist/server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      min_uptime: "10s",
      // DEPLOY_QUEUE_TOKEN must be present in the shell environment (see README).
      env: {
        NODE_ENV: "production",
        DEPLOY_QUEUE_BIND: "127.0.0.1",
        DEPLOY_QUEUE_PORT: "3910",
        DEPLOY_QUEUE_LOG_DIR: "/var/log/connect-deploys",
        DEPLOY_QUEUE_STATE_DIR: "/opt/connectcomms/app/ops/deploy-queue/var",
        DEPLOY_QUEUE_SQLITE_PATH: "/opt/connectcomms/app/ops/deploy-queue/var/queue.db",
        DEPLOY_QUEUE_POLL_MS: "3000",
        DEPLOY_QUEUE_MAX_QUEUED: "10",
      },
    },
  ],
};
