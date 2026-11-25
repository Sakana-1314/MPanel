/**
 * 轻量 cron 解析/预览（croner 5/6 字段风格）。
 * 仅用于表单实时校验与未来运行时间提示；最终调度以 agent 的 croner 为准。
 */

export interface CronPreset {
  label: string;
  value: string;
  description: string;
}

export const CRON_PRESETS: readonly CronPreset[] = [
  { label: '每 5 分钟', value: '*/5 * * * *', description: '日内每 5 分钟执行一次' },
  { label: '每小时整点', value: '0 * * * *', description: '每小时的第 0 分钟执行' },
  { label: '每天 03:00', value: '0 3 * * *', description: '每天凌晨 3 点执行' },
  { label: '每天 09:00', value: '0 9 * * *', description: '每天上午 9 点执行' },
  { label: '工作日 09:00', value: '0 9 * * 1-5', description: '周一至周五上午 9 点执行' },
  { label: '每周一 04:00', value: '0 4 * * 1', description: '每周一凌晨 4 点执行' },
  { label: '每月 1 日 02:00', value: '0 2 1 * *', description: '每月第一天凌晨 2 点执行' },
  { label: '每年 1 月 1 日', value: '0 0 1 1 *', description: '每年元旦零点执行' },
];

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const DOW_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  names?: Record<string, number>;
  normalize?: (value: number) => number;
}

const MINUTE: FieldSpec = { label: '分钟', min: 0, max: 59 };
const HOUR: FieldSpec = { label: '小时', min: 0, max: 23 };
const DOM: FieldSpec = { label: '日', min: 1, max: 31 };
const MONTH: FieldSpec = { label: '月', min: 1, max: 12, names: MONTH_NAMES };
const DOW: FieldSpec = { label: '星期', min: 0, max: 7, names: DOW_NAMES, normalize: (v) => (v === 7 ? 0 : v) };
const SECOND: FieldSpec = { label: '秒', min: 0, max: 59 };

export interface ParsedCron {
  expression: string;
  hasSeconds: boolean;
  seconds: number[];
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  domWildcard: boolean;
  dowWildcard: boolean;
}

function isWild(raw: string): boolean {
  return raw.trim() === '*' || raw.trim() === '?';
}

function valueOf(token: string, spec: FieldSpec): number {
  const text = token.trim().toLowerCase();
  if (text.length === 0) throw new Error(`${spec.label}字段包含空值`);
  const named = spec.names?.[text];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(text)) throw new Error(`${spec.label}字段“${token}”不是合法数字`);
  const value = Number(text);
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    throw new Error(`${spec.label}字段“${token}”超出范围（${spec.min}-${spec.max}）`);
  }
  return value;
}

function parseField(raw: string, spec: FieldSpec): number[] {
  const text = raw.trim();
  if (text.length === 0) throw new Error(`${spec.label}字段为空`);
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (piece.length === 0) throw new Error(`${spec.label}字段包含空值`);
    const [baseRaw, stepRaw] = piece.split('/');
    const base = baseRaw?.trim() ?? '';
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw.trim())) throw new Error(`${spec.label}步长“${stepRaw}”不合法`);
      step = Number(stepRaw.trim());
      if (step <= 0) throw new Error(`${spec.label}步长必须大于 0`);
    }
    let start: number;
    let end: number;
    if (base === '*' || base === '?') {
      start = spec.min;
      end = spec.max;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-');
      start = valueOf(a ?? '', spec);
      end = valueOf(b ?? '', spec);
      if (start > end) throw new Error(`${spec.label}范围“${base}”起点大于终点`);
    } else {
      start = valueOf(base, spec);
      end = stepRaw === undefined ? start : spec.max;
    }
    for (let value = start; value <= end; value += step) {
      values.add(spec.normalize === undefined ? value : spec.normalize(value));
    }
  }
  if (values.size === 0) throw new Error(`${spec.label}字段没有有效取值`);
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expression: string): ParsedCron {
  const text = expression.trim();
  if (text.length === 0) throw new Error('cron 表达式为空');
  const expanded = ALIASES[text.toLowerCase()] ?? text;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error('cron 表达式必须是 5 或 6 个字段（秒 分 时 日 月 周）');
  }
  const hasSeconds = parts.length === 6;
  const offset = hasSeconds ? 1 : 0;
  const seconds = hasSeconds ? parseField(parts[0]!, SECOND) : [0];
  const minutes = parseField(parts[offset]!, MINUTE);
  const hours = parseField(parts[offset + 1]!, HOUR);
  const daysOfMonth = parseField(parts[offset + 2]!, DOM);
  const months = parseField(parts[offset + 3]!, MONTH);
  const daysOfWeek = parseField(parts[offset + 4]!, DOW);
  return {
    expression: text,
    hasSeconds,
    seconds,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domWildcard: isWild(parts[offset + 2] ?? ''),
    dowWildcard: isWild(parts[offset + 4] ?? ''),
  };
}

export interface CronValidation {
  valid: boolean;
  error?: string;
  description?: string;
  advanced?: boolean;
}

export function validateCronExpression(expression: string): CronValidation {
  try {
    const parsed = parseCron(expression);
    return { valid: true, description: describeParsed(parsed), advanced: parsed.hasSeconds };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function describeCron(expression: string): string {
  try {
    return describeParsed(parseCron(expression));
  } catch {
    return '无效的 cron 表达式';
  }
}

function describeParsed(parsed: ParsedCron): string {
  const preset = CRON_PRESETS.find((item) => item.value === parsed.expression);
  if (preset !== undefined) return preset.description;
  if (parsed.expression === '@hourly') return '每小时整点执行';
  const secondsPrefix = parsed.hasSeconds ? `${parsed.seconds.join(',')} 秒 ` : '';
  const time = `${String(parsed.hours[0] ?? 0).padStart(2, '0')}:${String(parsed.minutes[0] ?? 0).padStart(2, '0')}`;

  if (isWildField(parsed.minutes, 0, 59) && isWildField(parsed.hours, 0, 23)) {
    return `${secondsPrefix}每分钟执行`;
  }
  const minuteStep = stepOf(parsed.expression.split(/\s+/), parsed.hasSeconds ? 1 : 0);
  if (minuteStep !== null && isWildField(parsed.hours, 0, 23) && isWildField(parsed.daysOfMonth, 1, 31)) {
    return `${secondsPrefix}每 ${minuteStep} 分钟执行`;
  }
  if (parsed.minutes.length === 1 && isWildField(parsed.hours, 0, 23) && isWildField(parsed.daysOfMonth, 1, 31)) {
    return `${secondsPrefix}每小时第 ${parsed.minutes[0]} 分钟执行`;
  }
  const weekdayPart = parsed.dowWildcard
    ? ''
    : ` · ${parsed.daysOfWeek.map((d) => DOW_LABEL[d] ?? d).join('、')}`;
  const dayPart = parsed.domWildcard
    ? ''
    : `每月 ${parsed.daysOfMonth.join('、')} 日${weekdayPart}`;
  if (dayPart.length > 0) return `${secondsPrefix}${dayPart} ${time}`;
  if (weekdayPart.length > 0) return `${secondsPrefix}${weekdayPart.slice(3)} ${time}`;
  if (isWildField(parsed.hours, 0, 23)) {
    return `${secondsPrefix}每小时第 ${parsed.minutes.join('、')} 分钟执行`;
  }
  if (parsed.daysOfMonth.length === 1 && isWildField(parsed.months, 1, 12)) {
    return `${secondsPrefix}每月 ${parsed.daysOfMonth[0]} 日 ${time}`;
  }
  return `${secondsPrefix}${parsed.expression}`;
}

function isWildField(values: number[], min: number, max: number): boolean {
  if (values.length !== max - min + 1) return false;
  for (let value = min; value <= max; value += 1) {
    if (!values.includes(value)) return false;
  }
  return true;
}

function stepOf(parts: string[], index: number): number | null {
  const raw = parts[index];
  if (raw === undefined || !raw.includes('/')) return null;
  const [base, step] = raw.split('/');
  if (base?.trim() !== '*') return null;
  const value = Number(step);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 在浏览器本地时区计算未来运行时间。
 * 分钟粒度搜索；6 字段表达式在同一年分钟内展开秒。
 */
export function nextCronRuns(expression: string, count = 5, from: Date = new Date()): Date[] {
  const parsed = parseCron(expression);
  const results: Date[] = [];
  const secondsSet = new Set(parsed.seconds);
  const minutesSet = new Set(parsed.minutes);
  const hoursSet = new Set(parsed.hours);
  const domSet = new Set(parsed.daysOfMonth);
  const monthSet = new Set(parsed.months);
  const dowSet = new Set(parsed.daysOfWeek);

  const cursor = new Date(from.getTime());
  cursor.setMilliseconds(0);
  cursor.setSeconds(0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (results.length < count && cursor <= limit) {
    if (!monthSet.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const domMatch = domSet.has(cursor.getDate());
    const dowMatch = dowSet.has(cursor.getDay());
    // 标准 cron：日与星期都受限时取 OR。
    const dayMatch = parsed.domWildcard || parsed.dowWildcard ? domMatch && dowMatch : domMatch || dowMatch;
    if (!dayMatch) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hoursSet.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minutesSet.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    for (const second of [...secondsSet].sort((a, b) => a - b)) {
      const candidate = new Date(cursor.getTime());
      candidate.setSeconds(second, 0);
      if (candidate.getTime() <= from.getTime()) continue;
      if (results.length < count) results.push(candidate);
    }
    cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
  }
  return results;
}
