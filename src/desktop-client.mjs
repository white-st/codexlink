import { EventEmitter } from 'node:events';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DesktopIpc, desktopError } from './desktop-ipc.mjs';

export function desktopTurns(state) {
  if (state?.turnHistory?.kind !== 'canonical') return state?.turns || [];
  const history = state.turnHistory.history, islands = history?.islands;
  if (!Array.isArray(islands) || islands.at(-1)?.newerBoundary?.status !== 'exhausted') return [];
  return islands.flatMap(island => (island.entries || []).map(entry => history.entitiesByKey?.[entry.value])).filter(Boolean);
}
const normalized = value => typeof value === 'string' ? path.resolve(value).toLowerCase() : '';
const canonicalStatus = status => status === 'cancelled' ? 'interrupted' : status;

function desktopInput(input) {
  if (!Array.isArray(input)) throw desktopError('消息内容不完整，请重新发送');
  return input.map(item => {
    if (item.type !== 'text') return structuredClone(item);
    // The desktop renders this input before app-server can apply its defaults.
    // Its untrusted-message decoder reads text_elements.length directly.
    const elements = item.text_elements ?? [];
    if (!Array.isArray(elements)) throw desktopError('文本标注格式无效，请重新发送');
    return structuredClone({ ...item, text_elements: elements });
  });
}

// A follower never owns or stops the desktop process. It sends only to the discovered owner.
export class DesktopClient extends EventEmitter {
  constructor({ ipc = () => new DesktopIpc() } = {}) { super(); this.ipcFactory = ipc; this.desktop = true; this.watching = false; }
  async start() { this.ready = true; }
  state() {
    const state = this.ipc?.state, turn = desktopTurns(state).at(-1);
    if (!state || this.ipc.failure || normalized(state.cwd) !== normalized(this.cwd)) throw desktopError('电脑会话的工作目录或连接已变化，请刷新后重试');
    if (!turn?.turnId || !['inProgress', 'completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status)) throw desktopError('电脑会话状态尚未就绪，请稍后刷新');
    const running = turn.status === 'inProgress';
    if (state.threadRuntimeStatus?.type !== (running ? 'active' : 'idle')) throw desktopError('电脑会话正在切换状态，请稍后刷新');
    return { state, turn, running };
  }
  observe() {
    if (!this.watching || !this.ready) return;
    let current; try { current = this.state(); } catch { return; } // Intermediate desktop patches are not terminal state evidence.
    const { state, turn, running } = current;
    if (this.submissionBaseline === turn.turnId) return;
    if (this.submissionBaseline) this.submissionUncertain = false;
    const attention = running && state.requests.some(r => r.completed !== true && r.params?.threadId === this.threadId);
    const key = `${turn.turnId}:${turn.status}:${attention}`;
    if (key === this.lastSeen) return;
    this.lastSeen = key;
    this.emit('message', { method: running ? 'turn/started' : 'turn/completed', params: { threadId: this.threadId,
      turn: { id: turn.turnId, status: canonicalStatus(turn.status), error: turn.error } } });
    this.emit('message', { method: 'desktop/attention', params: { threadId: this.threadId, waiting: attention } });
  }
  async request(method, params) {
    if (method === 'thread/resume') {
      this.threadId = params.threadId; this.cwd = await realpath(params.cwd); this.ipc = this.ipcFactory();
      this.ipc.on('state', () => this.observe());
      this.ipc.on('disconnected', error => { this.ready = false; if (!this.closing) this.emit('disconnected', error); });
      try {
        await this.ipc.open(this.threadId); const current = this.state();
        this.watching = true;
        if (current.running) this.observe();
        else this.lastSeen = `${current.turn.turnId}:${current.turn.status}:false`;
      }
      catch (error) { await this.closeAndWait(); throw error; }
      return { thread: { id: this.threadId } };
    }
    if (params.threadId !== this.threadId) throw desktopError('桌面任务不匹配');
    if (method === 'thread/read') {
      const current = this.state();
      return { thread: { id: this.threadId, cwd: this.cwd, status: this.ipc.state.threadRuntimeStatus,
        pendingSubmission: Boolean(this.submissionUncertain && current.turn.turnId === this.submissionBaseline),
        turns: structuredClone(desktopTurns(this.ipc.state).map(turn => ({ id: turn.turnId, status: canonicalStatus(turn.status),
          error: turn.error, items: turn.items || [], startedAt: turn.turnStartedAtMs ? Math.floor(turn.turnStartedAtMs / 1000) : null }))) } };
    }
    if (method === 'turn/start') {
      const { state, turn, running } = this.state();
      this.watching = true;
      if (running) { this.observe(); throw Object.assign(desktopError('电脑正在处理这条任务，请等本轮完成后再发送', 'DESKTOP_BUSY'), { turnId: turn.turnId }); }
      if (this.submissionUncertain || state.requests.some(r => r.completed !== true) || state.unconfirmedTurnSubmissions?.length) throw desktopError('请先在电脑确认上一条操作的结果，再发送新需求');
      if (normalized(params.cwd) !== normalized(this.cwd)) throw desktopError('任务目录不匹配');
      const input = desktopInput(params.input);
      this.submissionBaseline = turn.turnId;
      this.submissionUncertain = true;
      // Match the existing desktop protocol: inherit its permissions/model; never submit arbitrary context.
      const reply = await this.ipc.request('thread-follower-start-turn', 2, { conversationId: this.threadId,
        turnStart: { request: { threadId: this.threadId, clientUserMessageId: randomUUID(), input },
          context: { inheritThreadSettings: true } } }, { mutation: true });
      const result = reply.result?.result?.turn;
      if (!result?.id) throw desktopError('发送结果尚未确认，请刷新对话核对，不要重复发送', 'RPC_TIMEOUT', 503);
      this.submissionUncertain = false;
      this.observe(); return { turn: result };
    }
    if (method === 'turn/interrupt') {
      const { turn, running } = this.state();
      if (!running || turn.turnId !== params.turnId) throw desktopError('执行轮次已变化，请刷新后再停止');
      await this.ipc.request('thread-follower-interrupt-turn', 4,
        { conversationId: this.threadId, mode: 'user-stop', expectedTurnId: params.turnId }, { mutation: true });
      return {};
    }
    throw desktopError('这项操作请在电脑 Codex 中完成');
  }
  async closeAndWait() { this.closing = true; this.ready = false; this.ipc?.close(); }
  close() { void this.closeAndWait(); }
}
