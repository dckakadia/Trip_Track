// Unconditional launcher for process managers (pm2 forks via its own
// container script, so the run-directly guard in appServer.ts never fires).
import { startAppServer } from './appServer.ts';

const port = Number(process.env.PORT ?? 3000);
startAppServer(port).then(({ port: boundPort }) => {
  console.log(`TripTrack app running at http://localhost:${boundPort}`);
  if (!process.env.TRIPTRACK_DB) {
    console.log('Warning: TRIPTRACK_DB is not set; data is in-memory and lost on exit.');
  }
  if (!process.env.TRIPTRACK_SYNC_URL) {
    console.log('Note: TRIPTRACK_SYNC_URL is not set; running fully offline.');
  }
});
