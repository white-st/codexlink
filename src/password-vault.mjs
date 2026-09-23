import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const unavailable = () => Object.assign(new Error('密码显示密钥不可用，请恢复本机 password-view.key 后重启后台；原密码仍可登录'), { statusCode: 503 });

export class PasswordVault {
  async start(root, hasSavedPasswords) {
    const file = path.join(root, 'password-view.key');
    try { this.key = await readFile(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Never silently replace a key that protects existing password records.
      if (hasSavedPasswords) return;
      const key = randomBytes(32);
      await writeFile(file, key, { flag: 'wx', mode: 0o600 });
      this.key = key;
    }
    if (this.key.length !== 32) this.key = null;
  }
  seal(value, id, hash) {
    if (!this.key) throw unavailable();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${id}:${hash}`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { version: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64') };
  }
  open(saved, id, hash) {
    if (!this.key) throw unavailable();
    try {
      if (saved.version !== 1 || !/^[a-f0-9]{24}$/.test(saved.iv) || !/^[a-f0-9]{32}$/.test(saved.tag)) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(saved.iv, 'hex'));
      decipher.setAAD(Buffer.from(`${id}:${hash}`));
      decipher.setAuthTag(Buffer.from(saved.tag, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(saved.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw Object.assign(new Error('已保存的密码无法读取，请重新设置该账号密码'), { statusCode: 409 });
    }
  }
  close() { this.key?.fill(0); this.key = null; }
}
