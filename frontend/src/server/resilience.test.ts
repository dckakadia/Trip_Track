import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { closeDatabase } from '../db/connection.ts';
import { startAppServer } from './appServer.ts';

function rawRequest(port: number, requestText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(requestText));
    let buf = '';
    socket.on('data', (chunk) => (buf += chunk.toString()));
    socket.on('close', () => resolve(buf));
    socket.on('error', reject);
  });
}

test('a request with an empty Host header gets a clean response, not a crash', async () => {
  closeDatabase();
  const { server, port } = await startAppServer(0);
  let unhandled: unknown = null;
  const onUnhandledRejection = (reason: unknown) => {
    unhandled = reason;
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    // `new URL(path, \`http://${host}\`)` throws when host is empty — this must be caught
    // inside handleRequest, not escape as an unhandled rejection that kills the process.
    const response = await rawRequest(port, 'GET /api/trips HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n');
    assert.match(response, /^HTTP\/1\.1 \d{3}/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled, null, `expected no unhandled rejection, got: ${unhandled}`);

    // The server is still alive and serving normal requests afterward.
    const status = await fetch(`http://localhost:${port}/api/auth/status`);
    assert.equal(status.status, 200);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
    server.close();
  }
});
