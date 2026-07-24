// Unconditional launcher for process managers (pm2 forks via its own
// container script, so the run-directly guard in server.ts never fires).
import { startSyncServer } from './server.ts';

const port = Number(process.env.PORT ?? 4000);
startSyncServer(port).then(({ port: boundPort }) => {
  console.log(`TripTrack sync server listening on http://localhost:${boundPort}`);
});
