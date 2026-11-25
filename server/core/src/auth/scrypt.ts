import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

/**
 * 密码哈希：scrypt(N=16384, r=8, p=1, keyLen=64)，16 字节随机 salt。
 * 参数随哈希一起落盘，便于未来平滑升级；校验使用 timingSafeEqual。
 */
export interface StoredPassword {
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
}

export const SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  keyLen: 64,
  saltBytes: 16,
} as const;

function derive(
  password: string,
  salt: Buffer,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scryptCallback(password, salt, keyLen, options, (error, derivedKey) => {
      if (error !== null) reject(error);
      else resolvePromise(derivedKey);
    });
  });
}

function assertStored(stored: StoredPassword): void {
  const { N, r, p, salt, hash } = stored;
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 2 ||
    r < 1 ||
    p < 1 ||
    typeof salt !== 'string' ||
    salt.length === 0 ||
    typeof hash !== 'string' ||
    hash.length === 0
  ) {
    throw new Error('无效的密码哈希记录');
  }
}

export async function hashPassword(password: string): Promise<StoredPassword> {
  const salt = randomBytes(SCRYPT_PARAMS.saltBytes);
  const derived = await derive(password, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });
  return {
    salt: salt.toString('base64'),
    hash: derived.toString('base64'),
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  };
}

export async function verifyPassword(password: string, stored: StoredPassword): Promise<boolean> {
  try {
    assertStored(stored);
    const salt = Buffer.from(stored.salt, 'base64');
    const expected = Buffer.from(stored.hash, 'base64');
    const derived = await derive(password, salt, expected.length, {
      N: stored.N,
      r: stored.r,
      p: stored.p,
      maxmem: 64 * 1024 * 1024,
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * 用户不存在时也执行一次同参数 scrypt，避免通过响应时间枚举用户名。
 * 结果固定为 false，仅用于消耗时间。
 */
let dummyHash: Promise<StoredPassword> | undefined;
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  const stored = await dummyHash;
  await verifyPassword(password, stored);
  return false;
}
