import { Workbench } from '../src/workbench.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const workbench = new Workbench();
const report = { startedAt: new Date().toISOString(), checks: [], events: {} };
workbench.on('event', event => {
  const method = event.data.method || event.type;
  report.events[method] = (report.events[method] || 0) + 1;
  if (['turn/completed', 'error', 'notice'].includes(method)) {
    console.log(JSON.stringify({ event: method, status: event.data.params?.turn?.status,
      error: event.data.params?.turn?.error?.message || event.data.params?.error?.message || event.data.message }));
  }
});

async function runAndWait(task, prompt) {
  let cleanup;
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('测试执行超过 180 秒')); }, 180_000);
    const listener = event => {
      if (event.data.taskId === task.id && event.data.method === 'turn/completed') {
        cleanup(); resolve(event.data.params.turn);
      }
    };
    cleanup = () => { clearTimeout(timer); workbench.off('event', listener); };
    workbench.on('event', listener);
  });
  // Install completion handling before sending, including for fast failed turns.
  completion.catch(() => {});
  try {
    await workbench.send(task.id, prompt);
    const turn = await completion;
    assert.equal(turn.status, 'completed', turn.error?.message || 'Codex 未完成任务');
    return turn;
  } finally { cleanup(); }
}

try {
  const status = await workbench.start();
  assert.equal(status.connected, true);
  assert.equal(status.signedIn, true);
  report.checks.push('handshake-and-existing-login');
  const desktop = await workbench.listDesktop();
  report.desktopSampleCount = desktop.data.length;
  report.checks.push('read-existing-task-list');
  const task = await workbench.createTask('文件创建与继续修改');
  report.threadId = task.id;
  report.cwd = task.cwd;
  console.log(JSON.stringify({ created: task.id, cwd: task.cwd }));
  await runAndWait(task, 'This is an integration test. Actually create a file named verify.txt in the current working directory containing exactly REMOTE-CODEX-STEP-1. Use your available file tools. Do not only describe the steps. Do not read other projects, use subagents, access the network, or change any other file. Then report the path.');
  assert.equal((await readFile(path.join(task.cwd, 'verify.txt'), 'utf8')).trim(), 'REMOTE-CODEX-STEP-1');
  report.checks.push('real-file-created');
  await runAndWait(task, 'Continue this same task. Read verify.txt and replace STEP-1 with STEP-2, leaving everything else unchanged. Actually update the file, then report what changed.');
  assert.equal((await readFile(path.join(task.cwd, 'verify.txt'), 'utf8')).trim(), 'REMOTE-CODEX-STEP-2');
  report.checks.push('same-task-follow-up-updated-file');
  const history = await workbench.readThread(task.id);
  report.turnCount = history.turns?.length;
  assert.ok(report.turnCount >= 2);
  report.checks.push('history-readback');
  const artifacts = await workbench.files(task.id);
  assert.ok(artifacts.some(file => file.name === 'verify.txt'));
  assert.equal((await workbench.file(task.id, 'verify.txt')).toString().trim(), 'REMOTE-CODEX-STEP-2');
  report.checks.push('artifact-readback');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile('.runtime/live-verification.json', JSON.stringify(report, null, 2));
  await workbench.close();
  console.log(JSON.stringify(report, null, 2));
}
