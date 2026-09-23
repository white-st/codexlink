const $ = id => document.getElementById(id);
const state = { user: null, setup: false, setupAllowed: false, updates: 'events', tab: 'mobile', projects: [], tasks: [], questions: [], connected: false, signedIn: false, operations: new Set(), uncertain: new Set(), projectId: '', taskId: '', epoch: 0, selection: 0, refreshId: 0, detailId: 0, stream: null };
const labels = { pending: '待首次发送', idle: '待开始', starting: '正在启动', running: '执行中', completed: '已完成', interrupted: '已停止', failed: '失败', unknown: '待核实', waiting: '等待回答' };
let userListVersion = 0;
const passwordViews = new Set();
function hideManagedPasswords() { for (const hide of passwordViews) hide(); }
function setPasswordVisible(input, button, visible) {
  input.type = visible ? 'text' : 'password';
  button.textContent = visible ? '隐藏密码' : '显示密码';
  button.setAttribute('aria-pressed', String(visible));
}
function error(message) { $('error').textContent = message; $('error').classList.remove('hidden'); clearTimeout(error.timer); error.timer = setTimeout(() => $('error').classList.add('hidden'), 6000); }
async function api(route, input) {
  let response;
  try {
    response = await fetch('/api' + route, input === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Client': '1' }, body: JSON.stringify(input),
    });
  } catch {
    throw Object.assign(new Error(input === undefined ? '连接中断，请稍后刷新。' : '未收到操作结果，请连接恢复后刷新状态，勿重复提交。'), { uncertain: input !== undefined });
  }
  if (!response.headers.get('content-type')?.includes('application/json')) throw Object.assign(new Error('连接暂时不可用；若使用 DDNSTO，请重新打开外网地址完成访问验证，再刷新状态。'), { uncertain: input !== undefined });
  let result;
  try { result = await response.json(); }
  catch { throw Object.assign(new Error('操作结果未完整收到，请连接恢复后刷新状态，勿重复提交。'), { uncertain: input !== undefined }); }
  if (!response.ok) {
    if (response.status === 401 && state.user && !route.startsWith('/auth/login')) { clearAccount(); showAuth(); }
    throw new Error(result.error || '请求失败');
  }
  return result;
}
function clearSelection() {
  state.taskId = ''; state.selection++;
  $('messages').replaceChildren(); $('files').replaceChildren(); $('task-title').textContent = '';
  delete $('messages').dataset.signature;
  $('prompt').value = ''; $('questions').replaceChildren(); delete $('questions').dataset.signature;
  $('detail').classList.add('hidden'); $('empty').classList.remove('hidden');
}
function clearData() {
  userListVersion++; hideManagedPasswords(); passwordViews.clear();
  setPasswordVisible($('new-password'), $('show-new-password'), false);
  state.epoch++; state.stream?.close(); state.stream = null;
  state.projects = []; state.tasks = []; state.questions = []; state.projectId = ''; clearSelection();
  $('task-list').replaceChildren(); $('project-select').replaceChildren(); $('project-info').classList.add('hidden');
  delete $('task-list').dataset.signature; delete $('project-select').dataset.signature; delete $('project-settings').dataset.signature;
  $('current-project-name').textContent = ''; $('project-id').textContent = ''; $('user-list').replaceChildren();
  for (const id of ['project-form', 'task-form', 'project-settings', 'user-form', 'admin-grade-form', 'password-form']) $(id).reset();
  $('search').value = '';
}
function clearAccount() { clearData(); state.user = null; $('app-panel').classList.add('hidden'); $('logout').classList.add('hidden'); $('connection').textContent = '本机工作台'; }
function showAuth() {
  const localSetup = state.setup && state.setupAllowed;
  $('auth-panel').classList.remove('hidden'); $('setup-field').classList.toggle('hidden', !state.setup);
  $('auth-form').classList.toggle('hidden', state.setup && !state.setupAllowed);
  $('setup-code').required = localSetup;
  $('auth-title').textContent = state.setup ? localSetup ? '设置首个管理员' : '等待电脑完成设置' : '登录工作台';
  $('auth-hint').textContent = state.setup ? localSetup ? '设置完成后，原有验证任务将归入你的私有项目。' : '连接已建立。请先在电脑本机设置管理员，再用分配给你的账号登录。' : '使用管理员为你创建的账号登录。';
  $('auth-submit').textContent = state.setup ? '创建管理员并进入' : '登录';
  $('password').autocomplete = state.setup ? 'new-password' : 'current-password';
}
function renderConnection(info) {
  const connection = info.connection;
  if (!connection) return;
  state.updates = connection.updates;
  $('connection-mode').textContent = { local: '电脑本机', lan: '同 Wi-Fi 连接', remote: '外网加密连接 · 定时更新进度' }[connection.kind];
  $('connection-panel').classList.toggle('hidden', connection.kind !== 'local');
  const links = [];
  for (const url of connection.lanUrls || []) { const a = document.createElement('a'); a.href = url; a.textContent = `同 Wi-Fi：${url}`; links.push(a); }
  if (connection.publicUrl) { const a = document.createElement('a'); a.href = connection.publicUrl; a.textContent = `${connection.remoteProvider === 'ddnsto' ? 'DDNSTO 外网访问' : '外网测试'}：${connection.publicUrl}`; links.push(a); }
  if (connection.remoteProvider === 'ddnsto' && connection.proxyTarget) {
    const text = document.createElement('p'); text.textContent = `DDNSTO 控制台的目标主机填写：${connection.proxyTarget}`; links.push(text);
  }
  $('connection-links').replaceChildren(...links);
  $('connection-note').textContent = connection.remoteProvider === 'ddnsto'
    ? connection.publicUrl ? 'DDNSTO 地址已配置。请保持电脑、工作台与 DDNSTO 客户端运行；外网访问可能需要 DDNSTO 身份验证。' : '本机转发入口已准备，请在 DDNSTO 控制台添加映射，再配置生成的 HTTPS 地址。'
    : connection.publicUrl ? '外网地址为临时测试地址，重启后可能变化。电脑与工作台需要保持运行。' : connection.remoteStatus === 'starting' ? '正在准备临时外网地址。' : connection.remoteStatus === 'disabled' ? '同 Wi-Fi 地址用于局域网联调。' : '临时外网连接尚未建立；同 Wi-Fi 地址仍可使用。';
}
async function boot() {
  const epoch = state.epoch;
  const info = await api('/auth');
  if (epoch !== state.epoch) return;
  state.setup = info.setupRequired; state.setupAllowed = info.setupAllowed; state.user = info.user; renderConnection(info);
  if (!state.user) { clearAccount(); showAuth(); return; }
  $('auth-panel').classList.add('hidden'); $('app-panel').classList.remove('hidden'); $('logout').classList.remove('hidden');
  await refresh(); if (state.user) { connectEvents(); if ($('admin-panel').open) await loadUsers(); }
}
function option(value, text) { const node = document.createElement('option'); node.value = value; node.textContent = text; return node; }
function project() { return state.projects.find(p => p.id === state.projectId); }
function render() {
  if (!state.user) return;
  $('connection').textContent = `${state.user.username} · 等级 ${state.user.level}${state.user.role === 'admin' ? ' · 管理员' : ''}`;
  $('mobile-tab').setAttribute('aria-selected', String(state.tab === 'mobile'));
  $('desktop-tab').setAttribute('aria-selected', String(state.tab === 'desktop'));
  $('list-hint').textContent = state.tab === 'mobile' ? '手机项目拥有独立目录，默认只有自己可见。' : '显示本机已登记且你有权限查看的电脑任务。';
  const options = [option('', '全部可见项目'), ...state.projects.filter(p => p.source === state.tab).map(p => option(p.id, `${p.name} · ${p.shared ? '共享' : '私有'}`))];
  const signature = JSON.stringify(options.map(o => [o.value, o.textContent]));
  if ($('project-select').dataset.signature !== signature) { $('project-select').replaceChildren(...options); $('project-select').dataset.signature = signature; }
  if (!options.some(o => o.value === state.projectId)) { state.projectId = ''; clearSelection(); }
  $('project-select').value = state.projectId;
  $('project-create-box').classList.toggle('hidden', state.tab !== 'mobile');
  const p = project();
  $('task-form').classList.toggle('hidden', !(p?.owned && p.source === 'mobile'));
  $('project-info').classList.toggle('hidden', !p);
  if (p) {
    $('current-project-name').textContent = p.name;
    $('project-id').textContent = `项目编号：${p.id}`;
    $('project-privacy').textContent = `${p.shared ? '已共享' : '私有'} · 等级 ${p.level}`;
    $('project-rule').textContent = p.owned ? (p.shared ? '等级达标的用户可以只读查看本项目。' : '只有你能通过此软件查看本项目。') : '你可以查看此共享项目。只有所有者可以更改共享状态。';
    const admin = state.user.role === 'admin';
    $('project-settings').classList.toggle('hidden', !p.owned && !admin);
    $('share-label').classList.toggle('hidden', !p.owned); $('grade-label').classList.toggle('hidden', !admin);
    const settingsSignature = JSON.stringify([p.id, p.shared, p.level]);
    if ($('project-settings').dataset.signature !== settingsSignature) {
      $('project-settings').dataset.signature = settingsSignature;
      $('project-shared').checked = p.shared; $('edit-level').value = p.level;
    }
  }
  const query = $('search').value.trim().toLowerCase();
  const tasks = state.tasks.filter(t => t.source === state.tab && (!state.projectId || t.projectId === state.projectId) && `${t.name} ${t.projectName}`.toLowerCase().includes(query));
  const taskSignature = JSON.stringify([tasks, state.taskId]);
  if ($('task-list').dataset.signature !== taskSignature) {
    $('task-list').dataset.signature = taskSignature; $('task-list').replaceChildren();
    for (const task of tasks) {
      const button = document.createElement('button'); button.className = 'task-card' + (task.id === state.taskId ? ' active' : '');
      const title = document.createElement('strong'); title.textContent = task.name;
      const meta = document.createElement('small'); meta.textContent = `${task.projectName} · ${labels[task.status] || task.status}`;
      button.append(title, meta); button.onclick = () => selectTask(task).catch(e => error(e.message)); $('task-list').append(button);
    }
    if (!tasks.length) { const text = document.createElement('p'); text.className = 'muted'; text.textContent = query ? '没有匹配的可见任务' : '这个列表中还没有任务'; $('task-list').append(text); }
  }
  $('admin-panel').classList.toggle('hidden', state.user.role !== 'admin');
  renderControls();
}
function renderControls() {
  const task = state.tasks.find(t => t.id === state.taskId);
  $('composer').classList.toggle('hidden', !task?.canExecute);
  $('readonly-hint').classList.toggle('hidden', !task || task.canExecute);
  $('readonly-hint').textContent = task?.source === 'desktop' ? '已登记的电脑任务当前仅可查看与下载成果。' : '共享项目仅可查看，只有所有者可以发送需求。';
  if (!task) return;
  $('task-status').textContent = labels[task.status] || task.status;
  const handedOff = task.control && task.control !== 'mobile';
  const locked = state.operations.has(task.id) || handedOff, available = state.connected && state.signedIn;
  $('send').disabled = locked || task.busy || !available || state.uncertain.has(task.id);
  $('stop').disabled = locked || !task.activeTurn || !available;
  $('reconcile').disabled = state.operations.has(task.id);
  $('execution-hint').textContent = state.uncertain.has(task.id) ? '上次结果未确认，请先点击刷新状态' : !state.connected ? 'Codex 连接中断' : !state.signedIn ? '请先在电脑上的 Codex 登录' : task.busy ? '任务正在处理，可刷新状态或停止' : '将在当前项目中处理需求';
  if (handedOff) { $('task-status').textContent = task.control === 'desktop' ? '已交给电脑 · 可查看' : '正在交接或待核实'; $('execution-hint').textContent = '请在电脑 Codex 中继续操作；要切回手机，请在 App 的更多菜单选择恢复手机操作。'; }
  const questions = task.canExecute && !handedOff ? state.questions.filter(q => q.taskId === task.id) : [];
  const signature = JSON.stringify([task.id, questions]);
  if ($('questions').dataset.signature === signature) return;
  $('questions').dataset.signature = signature; $('questions').replaceChildren();
  for (const question of questions) {
    const form = document.createElement('form'); form.className = 'question';
    const inputs = new Map();
    for (const item of question.questions) {
      const label = document.createElement('label'); label.textContent = item.question;
      const input = document.createElement('input'); input.required = true; input.maxLength = 4000;
      if (item.isSecret) input.type = 'password';
      label.append(input); form.append(label); inputs.set(item.id, input);
      for (const choice of item.options || []) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = choice.label;
        button.title = choice.description || ''; button.onclick = () => { input.value = choice.label; }; form.append(button);
      }
    }
    const send = document.createElement('button'); send.textContent = '提交回答'; form.append(send);
    form.onsubmit = event => { event.preventDefault(); void submit(form, async () => {
      await api(`/tasks/${task.id}/answer`, { requestId: question.id, answers: Object.fromEntries([...inputs].map(([id, input]) => [id, input.value])) });
      await refresh();
    }); };
    $('questions').append(form);
  }
}
async function refresh() {
  if (!state.user) return;
  const epoch = state.epoch, request = ++state.refreshId;
  const data = await api('/status');
  if (epoch !== state.epoch || request !== state.refreshId) return;
  state.user = data.user; state.projects = data.projects; state.tasks = data.tasks;
  state.questions = data.questions; state.connected = data.connected; state.signedIn = data.signedIn;
  if (state.taskId && !state.tasks.some(t => t.id === state.taskId)) clearSelection();
  render();
}
function renderHistory(thread) {
  const signature = JSON.stringify(thread.turns || []);
  if ($('messages').dataset.signature === signature) return;
  const previousTop = $('messages').scrollTop;
  const follow = previousTop + $('messages').clientHeight >= $('messages').scrollHeight - 60;
  $('messages').dataset.signature = signature;
  $('messages').replaceChildren();
  for (const turn of thread.turns || []) for (const item of turn.items || []) {
    let text;
    if (item.type === 'userMessage') text = (item.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (item.type === 'agentMessage') text = item.text;
    if (!text) continue;
    const node = document.createElement('div'); node.className = 'message' + (item.type === 'userMessage' ? ' user' : '');
    const label = document.createElement('strong'); label.textContent = item.type === 'userMessage' ? '需求' : 'Codex';
    node.append(label, document.createTextNode(text)); $('messages').append(node);
  }
  if (!$('messages').childNodes.length) $('messages').textContent = '尚无对话。项目所有者可以发送第一条需求。';
  $('messages').scrollTop = follow ? $('messages').scrollHeight : previousTop;
}
async function refreshSelected(reconcile = false) {
  const id = state.taskId, epoch = state.epoch, selection = state.selection, request = ++state.detailId;
  if (!id) return;
  const data = reconcile ? await api(`/tasks/${id}/reconcile`, {}) : await api(`/history/${id}`);
  if (epoch !== state.epoch || selection !== state.selection || request !== state.detailId) return;
  renderHistory(reconcile ? data.thread : data);
  await refreshFiles();
  if (reconcile) await refresh();
}
async function refreshFiles() {
  const id = state.taskId, epoch = state.epoch, selection = state.selection; if (!id) return;
  const files = await api(`/tasks/${id}/files`);
  if (epoch !== state.epoch || selection !== state.selection) return;
  $('files').replaceChildren();
  for (const file of files) {
    const row = document.createElement('div'); row.className = 'artifact';
    const a = document.createElement('a'); a.textContent = file.name; a.href = `/api/tasks/${id}/file?name=${encodeURIComponent(file.name)}`; a.setAttribute('download', '');
    const size = document.createElement('span'); size.textContent = `${file.size} 字节`; row.append(a, size); $('files').append(row);
  }
  if (!files.length) $('files').textContent = '暂无项目文件';
}
async function selectTask(task) {
  clearSelection(); state.taskId = task.id; state.projectId = task.projectId;
  const epoch = state.epoch, selection = state.selection;
  $('empty').classList.add('hidden'); $('detail').classList.remove('hidden');
  $('task-title').textContent = task.name; $('source').textContent = task.source === 'mobile' ? '手机任务' : '电脑任务';
  $('task-status').textContent = labels[task.status] || task.status; $('messages').textContent = '正在读取对话…'; render();
  try {
    const history = await api(`/history/${task.id}`);
    if (epoch !== state.epoch || selection !== state.selection) return;
    renderHistory(history); await refreshFiles();
  } catch (e) { if (epoch === state.epoch && selection === state.selection) clearSelection(); throw e; }
}
function connectEvents() {
  if (state.updates !== 'events') { state.stream?.close(); state.stream = null; return; }
  state.stream?.close(); const stream = new EventSource('/api/events'); state.stream = stream;
  stream.addEventListener('access-changed', () => {
    if (state.stream !== stream) return;
    clearData(); boot().catch(e => error(e.message));
  });
  stream.onmessage = event => {
    if (state.stream !== stream) return;
    const data = JSON.parse(event.data);
    if (data.type === 'task-changed' && data.data.taskId === state.taskId) state.detailDirty = true;
    if (state.eventTimer) return;
    state.eventTimer = setTimeout(() => {
      state.eventTimer = null;
      if (state.stream !== stream) return;
      const detail = state.detailDirty; state.detailDirty = false;
      refresh().then(() => detail && refreshSelected()).catch(e => error(e.message));
    }, 250);
  };
  stream.onerror = () => { if (state.user) refresh().catch(() => { $('connection').textContent = '连接中断，等待恢复'; }); };
}
async function submit(form, operation) {
  const buttons = [...form.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
  try { await operation(); } catch (e) { error(e.message); }
  finally { buttons.forEach(b => b.disabled = false); renderControls(); }
}
$('auth-form').onsubmit = async event => {
  event.preventDefault(); $('auth-error').textContent = ''; $('auth-submit').disabled = true;
  try {
    await api(state.setup ? '/auth/setup' : '/auth/login', { username: $('username').value, password: $('password').value, code: $('setup-code').value });
    $('password').value = ''; $('setup-code').value = ''; clearAccount(); await boot();
  } catch (e) { $('auth-error').textContent = e.message; } finally { $('auth-submit').disabled = false; }
};
$('logout').onclick = async () => { try { await api('/auth/logout', {}); } catch (e) { error(e.message); } finally { clearAccount(); showAuth(); } };
for (const source of ['mobile', 'desktop']) $(source + '-tab').onclick = () => { state.tab = source; state.projectId = ''; clearSelection(); render(); };
$('project-select').onchange = () => { state.projectId = $('project-select').value; clearSelection(); render(); };
$('search').oninput = render;
$('refresh').onclick = () => refresh().then(() => refreshSelected()).catch(e => error(e.message));
$('refresh-files').onclick = () => refreshFiles().catch(e => error(e.message));
async function taskOperation(operation) {
  const id = state.taskId, epoch = state.epoch;
  if (!id || state.operations.has(id)) return;
  state.operations.add(id); renderControls();
  try { await operation(id); if (epoch === state.epoch) { await refresh(); await refreshSelected(); } }
  catch (e) { if (e.uncertain) state.uncertain.add(id); error(e.message); }
  finally { state.operations.delete(id); if (epoch === state.epoch) { await refresh().catch(() => {}); renderControls(); } }
}
$('composer').onsubmit = event => { event.preventDefault(); const prompt = $('prompt').value, epoch = state.epoch;
  void taskOperation(async id => { await api(`/tasks/${id}/send`, { prompt }); if (epoch === state.epoch && state.taskId === id && $('prompt').value === prompt) $('prompt').value = ''; });
};
$('stop').onclick = () => taskOperation(id => api(`/tasks/${id}/stop`, {}));
$('reconcile').onclick = () => taskOperation(async id => { await refreshSelected(true); state.uncertain.delete(id); });
$('project-form').onsubmit = event => { event.preventDefault(); void submit(event.currentTarget, async () => {
  const p = await api('/projects', { name: $('project-name').value, level: Number($('project-level').value) });
  $('project-name').value = ''; $('project-create-box').open = false; state.projectId = p.id; clearSelection(); await refresh();
}); };
$('task-form').onsubmit = event => { event.preventDefault(); void submit(event.currentTarget, async () => {
  const task = await api('/tasks', { name: $('task-name').value, projectId: state.projectId });
  $('task-name').value = ''; await refresh(); await selectTask(task);
}); };
$('project-settings').onsubmit = event => { event.preventDefault(); void submit(event.currentTarget, async () => {
  const p = project(); if (!p) return;
  const update = {}; if (p.owned) update.shared = $('project-shared').checked;
  if (state.user.role === 'admin') update.level = Number($('edit-level').value);
  await api(`/projects/${p.id}`, update); error('项目设置已保存'); await refresh();
}); };
async function loadUsers() {
  if (state.user?.role !== 'admin') return;
  const epoch = state.epoch, version = ++userListVersion;
  hideManagedPasswords(); passwordViews.clear();
  const users = await api('/admin/users'); if (epoch !== state.epoch || version !== userListVersion || !$('admin-panel').open) return;
  $('user-list').replaceChildren();
  for (const user of users) {
    const card = document.createElement('article'); card.className = 'account-card';
    const row = document.createElement('form'); row.className = 'user-row';
    const label = document.createElement('span'); label.textContent = `${user.username} · ${user.role === 'admin' ? '管理员' : '普通用户'}${user.disabled ? ' · 已停用' : ''}`;
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '9'; input.value = user.level; input.required = true; input.setAttribute('aria-label', `${user.username} 的等级`);
    const save = document.createElement('button'); save.textContent = '保存等级'; save.className = 'secondary';
    const disable = document.createElement('button'); disable.type = 'button'; disable.textContent = user.disabled ? '启用' : '停用'; disable.className = 'secondary'; disable.disabled = user.id === state.user.id;
    row.append(label, input, save, disable);
    row.onsubmit = event => { event.preventDefault(); void submit(row, async () => { await api(`/admin/users/${user.id}`, { level: Number(input.value) }); await loadUsers(); error('账号等级已保存'); }); };
    disable.onclick = () => submit(row, async () => { await api(`/admin/users/${user.id}`, { disabled: !user.disabled }); await loadUsers(); });
    const passwordRow = document.createElement('div'); passwordRow.className = 'account-password';
    const value = document.createElement('output'); value.className = 'password-value'; value.setAttribute('aria-label', `${user.username} 的密码`);
    const view = document.createElement('button'); view.type = 'button'; view.className = 'secondary'; view.setAttribute('aria-label', `查看 ${user.username} 的密码`);
    view.disabled = !user.passwordAvailable;
    let shown = false, viewRequest = 0, hideTimer;
    const hide = () => {
      viewRequest++; shown = false; clearTimeout(hideTimer);
      value.textContent = user.passwordAvailable ? '密码：••••••' : '密码：需重新设置后才能查看';
      view.textContent = '查看密码'; view.setAttribute('aria-pressed', 'false'); view.setAttribute('aria-label', `查看 ${user.username} 的密码`);
    };
    hide(); passwordViews.add(hide);
    view.onclick = async () => {
      if (shown) { hide(); return; }
      const request = ++viewRequest; view.disabled = true;
      try {
        const result = await api(`/admin/users/${user.id}/password/view`, {});
        if (request !== viewRequest || epoch !== state.epoch || version !== userListVersion || !card.isConnected || !$('admin-panel').open || document.hidden) return;
        value.textContent = result.password; shown = true; view.textContent = '隐藏密码';
        view.setAttribute('aria-pressed', 'true'); view.setAttribute('aria-label', `隐藏 ${user.username} 的密码`);
        hideTimer = setTimeout(hide, 30_000);
      } catch (e) { if (epoch === state.epoch && version === userListVersion) error(e.message); }
      finally { view.disabled = !user.passwordAvailable; }
    };
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'secondary';
    reset.textContent = user.id === state.user.id ? '修改我的密码' : '重新设置密码'; reset.setAttribute('aria-label', `重新设置 ${user.username} 的密码`);
    passwordRow.append(value, view, reset); card.append(row, passwordRow);
    if (user.id === state.user.id) {
      reset.onclick = () => { hideManagedPasswords(); $('my-password-panel').open = true; $('old-password').focus(); };
    } else {
      const form = document.createElement('form'); form.className = 'reset-password-form hidden';
      const note = document.createElement('p'); note.textContent = `为 ${user.username} 设置新密码（至少 6 位）。保存后原密码失效，该账号的所有设备需要重新登录。`;
      const passwordLabel = document.createElement('label'); passwordLabel.textContent = '新密码';
      const passwordInput = document.createElement('input'); passwordInput.id = `reset-password-${user.id}`; passwordInput.type = 'password'; passwordInput.autocomplete = 'new-password'; passwordInput.required = true; passwordInput.minLength = 6; passwordInput.maxLength = 128;
      passwordLabel.htmlFor = passwordInput.id;
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'secondary'; toggle.setAttribute('aria-controls', passwordInput.id); setPasswordVisible(passwordInput, toggle, false);
      toggle.onclick = () => setPasswordVisible(passwordInput, toggle, passwordInput.type === 'password');
      const controls = document.createElement('div'); controls.className = 'password-input'; controls.append(passwordInput, toggle);
      const savePassword = document.createElement('button'); savePassword.textContent = '保存新密码';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = '取消';
      const close = () => { form.reset(); setPasswordVisible(passwordInput, toggle, false); form.classList.add('hidden'); reset.setAttribute('aria-expanded', 'false'); };
      passwordViews.add(close); reset.setAttribute('aria-expanded', 'false');
      reset.onclick = () => { hideManagedPasswords(); form.classList.remove('hidden'); reset.setAttribute('aria-expanded', 'true'); passwordInput.focus(); };
      cancel.onclick = close;
      form.append(note, passwordLabel, controls, savePassword, cancel);
      form.onsubmit = event => { event.preventDefault(); void submit(form, async () => {
        await api(`/admin/users/${user.id}/password/reset`, { password: passwordInput.value });
        close(); await loadUsers(); error(`${user.username} 的密码已设置，可点击“查看密码”查看`);
      }); };
      card.append(form);
    }
    $('user-list').append(card);
  }
}
$('admin-panel').ontoggle = () => {
  if ($('admin-panel').open) loadUsers().catch(e => error(e.message));
  else { userListVersion++; hideManagedPasswords(); passwordViews.clear(); $('user-list').replaceChildren(); $('new-password').value = ''; setPasswordVisible($('new-password'), $('show-new-password'), false); }
};
$('show-new-password').onclick = () => setPasswordVisible($('new-password'), $('show-new-password'), $('new-password').type === 'password');
document.addEventListener('visibilitychange', () => { if (document.hidden) { hideManagedPasswords(); setPasswordVisible($('new-password'), $('show-new-password'), false); } });
window.addEventListener('pagehide', () => { hideManagedPasswords(); $('new-password').value = ''; });
$('user-form').onsubmit = event => { event.preventDefault(); void submit(event.currentTarget, async () => {
  await api('/admin/users', { username: $('new-username').value, password: $('new-password').value, level: Number($('new-level').value) });
  $('new-username').value = ''; $('new-password').value = ''; setPasswordVisible($('new-password'), $('show-new-password'), false); await loadUsers(); error('普通账号已创建，可点击“查看密码”查看');
}); };
$('admin-grade-form').onsubmit = event => { event.preventDefault(); void submit(event.currentTarget, async () => {
  await api(`/projects/${encodeURIComponent($('admin-project-id').value.trim())}`, { level: Number($('admin-project-level').value) }); error('项目等级已调整');
}); };
$('password-form').onsubmit = event => { event.preventDefault(); void submit(event.currentTarget, async () => {
  await api('/auth/password', { currentPassword: $('old-password').value, password: $('next-password').value });
  $('old-password').value = ''; $('next-password').value = ''; clearAccount(); showAuth(); error('密码已修改，请重新登录');
}); };
boot().catch(e => error(e.message));
setInterval(() => {
  if (state.user) refresh().then(() => refreshSelected()).catch(() => { $('connection').textContent = '连接中断，等待恢复'; });
  else api('/auth').then(info => {
    if (state.user) return;
    state.setup = info.setupRequired; state.setupAllowed = info.setupAllowed; renderConnection(info); showAuth();
  }).catch(() => { $('connection').textContent = '连接中断，等待恢复'; });
}, 4000);
