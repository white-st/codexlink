import path from 'node:path';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { isWithin } from './files.mjs';

export class ProjectStorage {
  constructor(runtime, config = {}) {
    this.runtime = path.resolve(runtime);
    this.legacyRoot = path.join(this.runtime, 'workspaces');
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => k !== 'mobileRoot')) {
      throw new Error('项目存储配置无效');
    }
    if ('mobileRoot' in config && (typeof config.mobileRoot !== 'string' || !path.isAbsolute(config.mobileRoot) || config.mobileRoot.includes('\0'))) {
      throw new Error('手机项目根目录必须是本机绝对路径');
    }
    this.mobileRoot = path.resolve(config.mobileRoot ?? path.join(this.legacyRoot, 'projects'));
    if (isWithin(this.mobileRoot, this.runtime)) throw new Error('手机项目根目录不能包含工作台运行数据目录');
  }
  static async load(runtime) {
    let config = {};
    try { config = JSON.parse(await readFile(path.join(runtime, 'storage.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return new ProjectStorage(runtime, config);
  }
  get roots() { return [...new Set([this.legacyRoot, this.mobileRoot])]; }
  allows(cwd) {
    return path.isAbsolute(cwd) && this.roots.some(root => path.relative(root, cwd) !== '' && isWithin(root, cwd));
  }
  async assertTaskDirectory(cwd) {
    if (!this.allows(cwd)) throw new Error('手机任务必须位于已配置的手机项目目录');
    const actual = await realpath(cwd);
    for (const root of this.roots.filter(root => isWithin(root, cwd))) {
      const actualRoot = await realpath(root);
      if (actual !== actualRoot && isWithin(actualRoot, actual)) return;
    }
    throw new Error('手机项目目录链接指向允许范围之外');
  }
  async createDirectory({ id, name, createdAt }) {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new Error('项目编号无效');
    const date = new Date(createdAt);
    if (!Number.isFinite(date.getTime())) throw new Error('项目创建时间无效');
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).map(part => [part.type, part.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}${parts.minute}${parts.second}`;
    const label = Array.from(name.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()).slice(0, 40).join('').replace(/[. ]+$/, '') || '项目';
    const parent = path.join(this.mobileRoot, day);
    await mkdir(parent, { recursive: true });
    const actualRoot = await realpath(this.mobileRoot), actualParent = await realpath(parent);
    if (!isWithin(actualRoot, actualParent)) throw new Error('日期目录链接指向手机项目根目录之外');
    const cwd = path.join(parent, `${time}_${label}_${id.slice(0, 8)}`);
    // Never merge two projects, even if a directory with this name already exists.
    await mkdir(cwd);
    return cwd;
  }
  async overlaps(cwd) {
    for (const root of this.roots) {
      let actualRoot;
      try { actualRoot = await realpath(root); }
      catch (error) { if (error.code !== 'ENOENT') throw error; actualRoot = root; }
      if (isWithin(actualRoot, cwd) || isWithin(cwd, actualRoot)) return true;
    }
    return false;
  }
}
