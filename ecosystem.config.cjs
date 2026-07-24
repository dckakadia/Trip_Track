// pm2 deployment config for gps-server (116.74.77.22).
// Ports 3600/4600 chosen because 3000/4000 are taken by other apps on this host.
// Runs on a user-local Node 24 (~/.local/node24) — system Node stays v20.
const HOME = process.env.HOME;
const NODE24 = `${HOME}/.local/node24/bin/node`;

module.exports = {
  apps: [
    {
      name: 'triptrack-sync',
      cwd: `${HOME}/triptrack/backend`,
      script: 'src/server.ts',
      interpreter: NODE24,
      interpreter_args: '--experimental-strip-types',
      env: {
        PORT: '4600',
        TRIPTRACK_SERVER_DB: `${HOME}/triptrack-data/server.db`,
        TRIPTRACK_UPLOAD_DIR: `${HOME}/triptrack-data/uploads`,
      },
    },
    {
      name: 'triptrack-app',
      cwd: `${HOME}/triptrack/frontend`,
      script: 'src/server/appServer.ts',
      interpreter: NODE24,
      interpreter_args: '--experimental-strip-types',
      env: {
        PORT: '3600',
        TRIPTRACK_DB: `${HOME}/triptrack-data/local.db`,
        TRIPTRACK_SYNC_URL: 'http://127.0.0.1:4600',
      },
    },
  ],
};
