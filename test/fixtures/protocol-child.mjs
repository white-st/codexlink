import { createInterface } from 'node:readline';
const reader = createInterface({ input: process.stdin });
reader.on('line', line => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  let result;
  if (message.method === 'initialize') result = { platformOs: 'linux', transport: 'fixture' };
  else if (message.method === 'test/environment') result = {
    marker: process.env.CODEX_LINK_TEST_ALLOWED,
    inheritedApiKey: Boolean(process.env.OPENAI_API_KEY),
    inheritedDesktopPipe: Boolean(process.env.CODEX_APP_TOOLS_PIPE_PATH),
  };
  else result = { echoed: message.params };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
});
