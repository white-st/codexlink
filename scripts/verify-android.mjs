import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { AccessStore } from '../src/access-store.mjs';
import { Workbench } from '../src/workbench.mjs';
import { createHttpServer } from '../src/server.mjs';
import { largeOffice } from '../test/fixtures/large-office.mjs';
import { MAX_FILE_BYTES } from '../src/file-limits.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const snapshot = async name => { try { return sha(await readFile(path.join('.runtime', name))); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const originals = await Promise.all(['access.json', 'registry.json'].map(async name => [name, await snapshot(name)]));
await mkdir('.runtime/tests', { recursive: true });
const root = await mkdtemp(path.resolve('.runtime/tests/android-'));
const access = new AccessStore(root); await access.start();
const client = new EventEmitter(); let index = 0; const histories = new Map();
client.close = () => {}; client.respond = () => {};
const workbench = new Workbench({ root, client }); workbench.connected = true; workbench.signedIn = true;
client.request = async (method, params) => {
  if (method === 'thread/start') return { thread: { id: 'android-fixture-' + (++index) } };
  if (method === 'turn/start') {
    const task = workbench.tasks.get(params.threadId);
    assert.match(params.input[0].text, /attachments\/[0-9a-f-]+\/中文说明\.docx/);
    assert.match(params.input[0].text, /attachments\/[0-9a-f-]+\/演示文稿\.pptx/);
    await writeFile(path.join(task.cwd, '中文成果.txt'), 'ANDROID-CONTRACT-OK\n');
    histories.set(task.id, { id: task.id, turns: [{ id: 'fixture-turn', status: 'completed', items: [{ type: 'agentMessage', text: '文件已创建' }] }] });
    client.emit('message', { method: 'turn/started', params: { threadId: task.id, turn: { id: 'fixture-turn' } } });
    client.emit('message', { method: 'turn/completed', params: { threadId: task.id, turn: { id: 'fixture-turn', status: 'completed' } } });
    return { turn: { id: 'fixture-turn' } };
  }
  return {};
};
workbench.readThread = async id => histories.get(id) || { id, turns: [] };
const server = createHttpServer(workbench, access, { controlToken: 'android-fixture-control' });
const run = (exe, args) => new Promise((resolve, reject) => {
  const process = spawn(exe, args, { stdio: 'inherit', windowsHide: true });
  process.on('error', reject); process.on('exit', code => code === 0 ? resolve() : reject(new Error(`Android verification exit ${code}`)));
});
try {
  const owner = await access.setup({ code: access.setupCode, username: 'android_owner', password: '628415' });
  await access.createUser(owner.user.id, { username: 'android_viewer', password: '628415', level: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const java = process.env.ANDROID_JDK || process.env.JAVA_HOME;
  if (!java) throw new Error('Set JAVA_HOME or ANDROID_JDK before Android verification');
  const classes = path.join(root, 'java'); await mkdir(classes);
  const largeFixture = path.join(root, '100MB.pptx');
  await largeOffice('test/fixtures/attachments/演示文稿.pptx', largeFixture, MAX_FILE_BYTES);
  await run(path.join(java, 'bin/javac.exe'), ['-encoding', 'UTF-8', '--release', '8', '-d', classes, 'android/src/com/codexlink/mobile/ApiClient.java', 'android/src/com/codexlink/mobile/OfficeAttachment.java', 'android/tests/ContractTest.java']);
  await run(path.join(java, 'bin/java.exe'), ['-Xmx32m', '-cp', classes, 'com.codexlink.mobile.ContractTest', origin, 'test/fixtures/attachments/中文说明.docx', 'test/fixtures/attachments/演示文稿.pptx', largeFixture]);
  assert.equal(access.data.projects.length, 0); assert.equal(access.data.bindings.length, 0);
  assert.equal(workbench.tasks.size, 1);
  for (const task of workbench.tasks.values()) assert.equal(await readFile(path.join(task.cwd, '中文成果.txt'), 'utf8'), 'ANDROID-CONTRACT-OK\n');
  const release = JSON.parse(await readFile('android/output/release.json', 'utf8'));
  const publicRelease = await (await fetch(origin + '/downloads/release.json')).json();
  assert.deepEqual(publicRelease, release);
  assert.equal(release.packageName, 'com.codexlink.mobile'); assert.ok(Number.isInteger(release.versionCode) && release.versionCode >= 9);
  assert.equal(release.minSdk, 26); assert.equal(typeof release.notes, 'string'); assert.ok(release.notes.length > 0 && release.notes.length <= 4000);
  assert.equal(release.file, `CodexLink-${release.version}.apk`);
  assert.equal((await fetch(origin + '/downloads/CodexLink-999.0.0.apk')).status, 404);
  const apk = await fetch(origin + '/downloads/' + release.file, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document' } });
  assert.equal(apk.status, 200); assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.match(apk.headers.get('content-disposition'), /attachment/); assert.equal(sha(Buffer.from(await apk.arrayBuffer())), release.sha256);
  const landing = await fetch(origin + '/android', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document' } });
  assert.equal(landing.status, 200); assert.match(await landing.text(), /下载安卓安装包/);
  for (const route of ['/downloads/../.runtime/android-signing/password.txt', '/downloads/test-release.p12', '/downloads/other.apk', '/api/status']) assert.notEqual((await fetch(origin + route)).status, 200);
  for (const [name, hash] of originals) assert.equal(await snapshot(name), hash, 'Formal data unchanged');
  const report = { passed: true, checkedAt: new Date().toISOString(), fixtureRoot: root, apk: release, fileLimitBytes: MAX_FILE_BYTES, largeFileRoundTrip: '100 MiB Office fixture through actual JVM with 32 MiB heap and Node HTTP, SHA256 identical; attached to send', contract: 'Actual JVM ApiClient + existing HTTP/AccessStore/Portal/Workbench; simulated Codex backend', staticDownload: true, formalDataUnchanged: true, androidDevice: 'Not exercised by this JVM contract check; native UI evidence is recorded separately' };
  await writeFile('.runtime/android-verification.json', JSON.stringify(report, null, 2));
  console.log('Signed APK serving, exact SHA256, public landing and formal data integrity passed. Native UI is verified separately.');
} finally {
  server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await workbench.close(); await access.close();
}
