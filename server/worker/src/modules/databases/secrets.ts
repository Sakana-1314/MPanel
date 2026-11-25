import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PanelError, SECRET_CIPHER_VERSION } from '@mpanel/shared';
import type { SecretCipher } from '@mpanel/shared';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_FILE_NAME = 'secrets.key';
/** 密钥文件只允许属主读写；Windows 上 mode 会被忽略，但不影响加解密正确性。 */
export const SECRET_KEY_FILE_MODE = 0o600;

/** AES-256-GCM envelope: `v1:<iv>:<tag>:<ciphertext>`（base64url）。 */
export function createSecretCipher(key: Buffer): SecretCipher {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new PanelError('INTERNAL', `加密密钥必须是 ${KEY_BYTES} 字节`);
  }
  const material = Buffer.from(key);

  return {
    encrypt(plain: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, material, iv);
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
        throw new PanelError('INTERNAL', '无法解密的凭据格式（密钥可能已更换）');
      }
      const iv = decodeBase64Url(parts[1] ?? '');
      const tag = decodeBase64Url(parts[2] ?? '');
      const ciphertext = decodeBase64Url(parts[3] ?? '');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new PanelError('INTERNAL', '无法解密的凭据格式（密钥可能已更换）');
      }
      try {
        const decipher = createDecipheriv(ALGORITHM, material, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch (error) {
        throw new PanelError('INTERNAL', '无法解密已保存的凭据（密钥可能已更换）', undefined, {
          cause: error,
        });
      }
    },
  };
}

/**
 * 读取已有密钥文件，不存在时用 `wx` 原子创建（0600），避免 core 与 worker
 * 共享 MPANEL_HOME 时互相覆盖。`envKey`（MPANEL_SECRET_KEY）优先。
 */
export function loadOrCreateSecretKey(homeDir: string, envKey?: string): Buffer {
  return loadOrCreateSecretKeyAt(join(homeDir, KEY_FILE_NAME), envKey);
}

/** 同 loadOrCreateSecretKey，但密钥路径可配置（WorkerConfig.security.keyFile）。 */
export function loadOrCreateSecretKeyAt(keyFile: string, envKey?: string): Buffer {
  if (typeof envKey === 'string' && envKey.trim().length > 0) {
    return parseKeyMaterial(envKey, 'MPANEL_SECRET_KEY');
  }

  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });

  let created = false;
  try {
    const fd = openSync(keyFile, 'wx', SECRET_KEY_FILE_MODE);
    try {
      const material = randomBytes(KEY_BYTES).toString('base64');
      writeSync(fd, `${material}\n`, 0, 'utf8');
      fsyncSync(fd);
      created = true;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) {
      throw new PanelError(
        'INTERNAL',
        `无法创建密钥文件 ${keyFile}（${describeErrno(error)}）`,
        { path: keyFile },
        { cause: error },
      );
    }
  }

  // 已存在时收紧权限；Windows 上是空操作。
  if (!created) {
    try {
      chmodSync(keyFile, SECRET_KEY_FILE_MODE);
    } catch {
      // 某些文件系统不支持 chmod，忽略。
    }
  }

  let raw: Buffer;
  try {
    raw = readFileSync(keyFile);
  } catch (error) {
    throw new PanelError(
      'INTERNAL',
      `无法读取密钥文件 ${keyFile}（${describeErrno(error)}）`,
      { path: keyFile },
      { cause: error },
    );
  }
  return parseKeyFile(raw, keyFile);
}

/**
 * 兼容 core/worker 共享的密钥文件：默认是 base64 文本，但也接受 64 位十六进制
 * 或直接存放的 32 字节原始密钥（例如其他实现用 writeFile 写入 Buffer）。
 */
function parseKeyFile(raw: Buffer, source: string): Buffer {
  if (raw.length === KEY_BYTES) return Buffer.from(raw);
  const latin = raw.toString('latin1').trim();
  if (Buffer.byteLength(latin, 'latin1') === KEY_BYTES) {
    return Buffer.from(latin, 'latin1');
  }
  return parseKeyMaterial(latin, source);
}

function parseKeyMaterial(raw: string, source: string): Buffer {
  const value = raw.trim();
  if (value.length === 0) {
    throw new PanelError('INTERNAL', `密钥内容为空：${source}`);
  }
  // 允许 64 位十六进制（32 字节）或 base64/base64url。
  const material = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (material.length !== KEY_BYTES) {
    throw new PanelError(
      'INTERNAL',
      `密钥必须是 32 字节（base64 或 64 位十六进制）：${source}`,
    );
  }
  return material;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new PanelError('INTERNAL', '无法解密的凭据格式（密钥可能已更换）');
  }
  return Buffer.from(value, 'base64url');
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function describeErrno(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown error';
}
