import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { PanelError, SECRET_CIPHER_VERSION, type SecretCipher } from '@mpanel/shared';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * 机器凭据加密（AES-256-GCM），与 worker 的实现相互独立但信封格式一致。
 * 密钥来自 `MPANEL_SECRET_KEY`（base64 32 字节），否则使用 `$HOME/secrets.key`。
 */
export function createCredentialCipher(homeDir: string, envKey?: string): SecretCipher {
  const key = loadOrCreateKey(homeDir, envKey);

  return {
    encrypt(plain: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        SECRET_CIPHER_VERSION,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join(':');
    },
    decrypt(payload: string): string {
      const parts = payload.split(':');
      if (parts.length !== 4 || parts[0] !== SECRET_CIPHER_VERSION) {
        throw new PanelError('INTERNAL', '机器凭据密文格式无效', {
          hint: '请重新录入机器 token（密文损坏或版本不匹配）',
        });
      }
      const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
      let iv: Buffer;
      let tag: Buffer;
      let data: Buffer;
      try {
        iv = Buffer.from(ivPart, 'base64url');
        tag = Buffer.from(tagPart, 'base64url');
        data = Buffer.from(dataPart, 'base64url');
      } catch (cause) {
        throw new PanelError('INTERNAL', '机器凭据密文编码无效', {
          hint: '请重新录入机器 token',
        }, { cause });
      }
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new PanelError('INTERNAL', '机器凭据密文参数无效', {
          hint: '请重新录入机器 token',
        });
      }
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch (cause) {
        throw new PanelError('INTERNAL', '无法解密机器凭据', {
          hint: '确认 MPANEL_SECRET_KEY 未被更换；如已轮换密钥请重新录入机器 token',
        }, { cause });
      }
    },
  };
}

/** reverse-ws 注册 secret 只保存 SHA-256（十六进制）用于比对。 */
export function hashMachineSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 一次性 machine secret，只在创建/轮换响应中出现。 */
export function generateMachineSecret(): string {
  return `mp_${randomBytes(KEY_BYTES).toString('base64url')}`;
}

/** worker loopback token（隧道/HTTP 的 MPANEL_TOKEN），同样一次性下发。 */
export function generateWorkerToken(): string {
  return `mp_${randomBytes(KEY_BYTES).toString('base64url')}`;
}

/** 定长哈希比较，避免长度/内容时序泄漏。 */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function loadOrCreateKey(homeDir: string, envKey?: string): Buffer {
  if (envKey !== undefined && envKey.length > 0) {
    const decoded = Buffer.from(envKey, 'base64');
    if (decoded.length !== KEY_BYTES) {
      throw new PanelError('INTERNAL', 'MPANEL_SECRET_KEY 无效', {
        hint: 'MPANEL_SECRET_KEY 必须是 base64 编码的 32 字节密钥',
      });
    }
    return decoded;
  }

  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(homeDir, 'secrets.key');
  try {
    const fd = openSync(keyFile, 'wx', 0o600);
    try {
      const key = randomBytes(KEY_BYTES);
      writeSync(fd, `${key.toString('base64')}\n`);
      fsyncSync(fd);
      return key;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const raw = readFileSync(keyFile, 'utf8').trim();
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length !== KEY_BYTES) {
        throw new PanelError('INTERNAL', 'secrets.key 内容无效', {
          hint: '删除或修复 $MPANEL_HOME/secrets.key 后重新录入机器 token',
        });
      }
      return decoded;
    }
    throw new PanelError('INTERNAL', '无法创建或读取 secrets.key', {
      hint: '检查 $MPANEL_HOME 目录权限，或显式配置 MPANEL_SECRET_KEY',
    }, { cause: error });
  }
}
