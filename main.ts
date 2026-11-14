// main.ts — entrypoint. Binds an ephemeral port, registers with the trial
// environment, polls until the trial is done, then exits. Written fresh in
// this session.
import { createServer } from 'node:http';
import { createApp } from './app.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const server = createServer(createApp());
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not bind a port');
  const port = address.port;

  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) {
    // Standalone mode (local smoke tests): just stay up.
    console.log(`forge listening on http://127.0.0.1:${port} (no MAKEFUN_ENV_URL; standalone mode)`);
    return;
  }

  // Register; a 409 means another entry already registered — keep waiting
  // like any other. Other failures retry with a short backoff.
  let registered = false;
  let backoff = 250;
  while (!registered) {
    try {
      const register = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (register.ok || register.status === 409) {
        registered = true;
      } else {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 5000);
      }
    } catch {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 5000);
    }
  }

  // Poll /done until the trial is over; never exit before the env says so.
  backoff = 250;
  for (;;) {
    try {
      const doneRes = await fetch(`${envUrl}/done`);
      if (doneRes.ok) {
        const doneBody = (await doneRes.json()) as { done?: boolean };
        if (doneBody.done === true) break;
        backoff = 250;
      } else {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 5000);
      }
    } catch {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 5000);
      continue;
    }
    await sleep(250);
  }

  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
