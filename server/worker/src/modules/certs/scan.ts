/**
 * 证书扫描：只读解析 Caddy 数据目录中的 X.509 证书。
 *
 * - 默认扫描 `<caddyDataDir>/certificates/**` 下的 .crt/.pem；配置目录不存在时
 *   探测常见 Caddy data 路径（ask: 可配置 + 默认探测）。
 * - 只用 node:crypto 的 X509Certificate 解析证书块；不解析、不返回私钥。
 * - 单个文件解析失败跳过并 warning，绝不让整个列表 500。
 * - 按 SHA-256 指纹去重（Caddy 可能同时有 .crt/.pem 副本）。
 */
import { X509Certificate } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CertificateInfo } from '@mpanel/shared';
import type { WorkerLogger } from '../../logger.js';

const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const MAX_CERT_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_FILES = 5_000;
const MAX_SCAN_DEPTH = 10;
const EXPIRING_THRESHOLD_DAYS = 14;
const DAY_MS = 86_400_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function normalizeFingerprint(value: string): string {
  return value.replace(/:/g, '').toLowerCase();
}

function normalizeDn(value: string): string {
  return value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');
}

function extractCommonName(subject: string): string | null {
  const match = /(?:^|,\s*)CN=([^,]+)/i.exec(subject);
  if (!match) return null;
  return match[1]!.replace(/^"(.*)"$/, '$1').trim() || null;
}

function pushDomain(out: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) return;
  if (out.some((domain) => domain.toLowerCase() === trimmed.toLowerCase())) return;
  out.push(trimmed);
}

function extractDomains(
  subjectAltName: string | undefined,
  commonName: string | null,
): string[] {
  const domains: string[] = [];
  if (subjectAltName) {
    for (const entry of subjectAltName.split(',')) {
      const trimmed = entry.trim();
      const dns = /^DNS:(.+)$/i.exec(trimmed);
      if (dns) {
        pushDomain(domains, dns[1]!);
        continue;
      }
      const ip = /^IP Address:(.+)$/i.exec(trimmed);
      if (ip) pushDomain(domains, ip[1]!);
    }
  }
  if (domains.length === 0 && commonName) pushDomain(domains, commonName);
  return domains;
}

function detectSource(filePath: string, issuer: string): CertificateInfo['source'] {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/');
  // 只看 certificates/ 之后的目录段，避免把宿主的 AppData/Local 误判为 local CA。
  const certificatesIndex = segments.lastIndexOf('certificates');
  const relevant =
    certificatesIndex >= 0 ? segments.slice(certificatesIndex + 1) : segments;
  if (relevant.some((segment) => segment === 'acme' || segment.startsWith('acme-'))) {
    return 'acme';
  }
  if (relevant.includes('local')) return 'local';
  if (/let's encrypt|zerossl|acme|buypass|google trust services/i.test(issuer)) return 'acme';
  return 'unknown';
}

function certificateStatus(notAfterMs: number, daysRemaining: number): CertificateInfo['status'] {
  if (notAfterMs < Date.now()) return 'expired';
  if (daysRemaining <= EXPIRING_THRESHOLD_DAYS) return 'expiring';
  return 'valid';
}

function buildCertificateInfo(certificate: X509Certificate, filePath: string): CertificateInfo | null {
  const validFrom = new Date(certificate.validFrom);
  const validTo = new Date(certificate.validTo);
  if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) return null;

  const subject = normalizeDn(certificate.subject);
  const issuer = normalizeDn(certificate.issuer);
  const commonName = extractCommonName(subject);
  const domains = extractDomains(certificate.subjectAltName, commonName);
  const fingerprint = normalizeFingerprint(certificate.fingerprint256);
  if (fingerprint.length === 0) return null;
  const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / DAY_MS);

  let keyType: string | null = null;
  try {
    keyType = certificate.publicKey.asymmetricKeyType ?? null;
  } catch {
    keyType = null;
  }

  return {
    id: fingerprint,
    domains,
    commonName,
    issuer: issuer.length > 0 ? issuer : 'unknown',
    subject: subject.length > 0 ? subject : 'unknown',
    notBefore: validFrom.toISOString(),
    notAfter: validTo.toISOString(),
    daysRemaining,
    serialNumber: certificate.serialNumber,
    fingerprintSha256: fingerprint,
    keyType,
    source: detectSource(filePath, issuer),
    path: filePath,
    status: certificateStatus(validTo.getTime(), daysRemaining),
  };
}

/** 解析单个证书文件；不是 PEM 证书、损坏或不可读时返回 null。 */
export async function parseCertificateFile(filePath: string): Promise<CertificateInfo | null> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size === 0 || info.size > MAX_CERT_BYTES) return null;

  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch {
    return null;
  }

  const match = PEM_CERTIFICATE_PATTERN.exec(raw.toString('utf8'));
  if (!match) return null;
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(match[0]);
  } catch {
    return null;
  }
  try {
    return buildCertificateInfo(certificate, filePath);
  } catch {
    return null;
  }
}

function candidateDataDirs(configured: string): string[] {
  const home = os.homedir();
  const candidates = [
    configured,
    path.join(home, 'caddy', 'data'),
    path.join(home, '.local', 'share', 'caddy'),
    '/var/lib/caddy/.local/share/caddy',
    'C:\\ProgramData\\caddy\\data',
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (candidate.trim().length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return info.isDirectory();
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) {
      return false;
    }
    return false;
  }
}

async function collectCertificateFiles(
  dir: string,
  depth: number,
  out: string[],
  logger: WorkerLogger,
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    logger.warn('读取证书目录失败，已跳过', { dir, error: messageOf(error) });
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES) return;
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectCertificateFiles(fullPath, depth + 1, out, logger);
      continue;
    }
    if (entry.isFile() && /\.(crt|pem)$/i.test(entry.name)) out.push(fullPath);
  }
}

/**
 * 扫描 Caddy data 目录下的证书。目录不存在/不可读时 available=false，
 * caddy 二进制缺失不影响本函数。
 */
export async function scanCertificates(
  dataDir: string,
  logger: WorkerLogger,
): Promise<{ available: boolean; reason?: string; items: CertificateInfo[] }> {
  let resolved = dataDir;
  let found = await isDirectory(dataDir);
  if (!found) {
    for (const candidate of candidateDataDirs(dataDir)) {
      if (candidate === dataDir) continue;
      if (await isDirectory(candidate)) {
        resolved = candidate;
        found = true;
        logger.info('配置的 Caddy 数据目录不存在，已使用探测到的目录', {
          configured: dataDir,
          resolved,
        });
        break;
      }
    }
  }
  if (!found) {
    return {
      available: false,
      reason:
        `Caddy 数据目录不存在或不可读：${dataDir}。` +
        '请设置 MPANEL_CADDY_DATA_DIR 指向 Caddy 的 data 目录（常见为 ~/.local/share/caddy 或 /var/lib/caddy/.local/share/caddy）。',
      items: [],
    };
  }

  const certificatesDir = path.join(resolved, 'certificates');
  const scanRoot = (await isDirectory(certificatesDir)) ? certificatesDir : resolved;
  const files: string[] = [];
  await collectCertificateFiles(scanRoot, 0, files, logger);
  files.sort();

  const byFingerprint = new Map<string, CertificateInfo>();
  for (const filePath of files) {
    const certificate = await parseCertificateFile(filePath);
    if (!certificate) {
      logger.warn('跳过无法解析的证书文件', { path: filePath });
      continue;
    }
    if (!byFingerprint.has(certificate.id)) byFingerprint.set(certificate.id, certificate);
  }

  const items = [...byFingerprint.values()].sort(
    (a, b) => a.notAfter.localeCompare(b.notAfter) || a.id.localeCompare(b.id),
  );
  return { available: true, items };
}
