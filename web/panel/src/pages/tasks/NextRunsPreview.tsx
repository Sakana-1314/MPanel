import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, RefreshCw } from 'lucide-react';
import { getNextRuns, tasksKeys } from '../../api/tasks';
import { describeError } from '../../api/errors';
import { formatDate, formatRelativeTime } from '../../lib/format';
import { cn } from '../../lib/cn';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/ErrorState';

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

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const DOW_LABEL: Record<number, string> = {
  0: '周日',
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
};

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  names?: Record<string, number>;
  allowQuestion?: boolean;
}

const MINUTE_FIELD: FieldSpec = { label: '分钟', min: 0, max: 59 };
const HOUR_FIELD: FieldSpec = { label: '小时', min: 0, max: 23 };
const DOM_FIELD: FieldSpec = { label: '日', min: 1, max: 31, allowQuestion: true };
const MONTH_FIELD: FieldSpec = { label: '月', min: 1, max: 12, names: MONTH_NAMES };
const DOW_FIELD: FieldSpec = { label: '星期', min: 0, max: 7, names: DOW_NAMES, allowQuestion: true };
const SECOND_FIELD: FieldSpec = { label: '秒', min: 0, max: 59 };

export interface ParsedCron {
  expression: string;
  hasSeconds: boolean;
  /** 归一化后的字段原始值，固定长度 6：[秒, 分, 时, 日, 月, 星期]。 */
  rawFields: readonly [string, string, string, string, string, string];
  seconds: ReadonlySet<number>;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /** 日/星期字段是否为通配（标准 cron：两者都受限时取 OR）。 */
  domWildcard: boolean;
  dowWildcard: boolean;
}

function fieldValue(token: string, spec: FieldSpec): number {
  const text = token.trim().toLowerCase();
  if (text.length === 0) throw new Error(`${spec.label}字段包含空值`);
  const named = spec.names?.[text];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(text)) {
    throw new Error(`${spec.label}字段“${token}”不是合法数字${spec.names === undefined ? '' : '或名称'}`);
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    throw new Error(`${spec.label}字段“${token}”超出范围（${spec.min}-${spec.max}）`);
  }
  return value;
}

function allValues(spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (let value = spec.min; value <= spec.max; value += 1) values.add(value);
  return values;
}

/** 解析单个 cron 字段（支持 *、?、列表、范围、步长与月份/星期英文名）。 */
function parseField(raw: string, spec: FieldSpec, normalize?: (value: number) => number): Set<number> {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) throw new Error(`${spec.label}字段为空`);
  if (text === '?') {
    if (spec.allowQuestion !== true) throw new Error(`${spec.label}字段不支持“?”`);
    const values = allValues(spec);
    return normalize === undefined ? values : new Set([...values].map(normalize));
  }
  if (/[lw#]/.test(text)) {
    throw new Error(`${spec.label}字段不支持 L/W/# 语法，请使用标准 cron 表达式`);
  }
  const values = new Set<number>();
  for (const part of text.split(',')) {
    if (part.trim().length === 0) throw new Error(`${spec.label}字段包含空列表项`);
    const segments = part.split('/');
    if (segments.length > 2) throw new Error(`${spec.label}字段“${part}”格式不正确`);
    const rangePart = (segments[0] ?? '').trim();
    const stepPart = segments[1]?.trim();
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) throw new Error(`${spec.label}字段的步长必须是正整数`);
      step = Number(stepPart);
      if (step < 1) throw new Error(`${spec.label}字段的步长必须大于 0`);
    }

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2) throw new Error(`${spec.label}字段“${part}”范围格式不正确`);
      start = fieldValue(bounds[0] ?? '', spec);
      end = fieldValue(bounds[1] ?? '', spec);
      if (start > end) throw new Error(`${spec.label}字段“${part}”的起始值大于结束值`);
    } else {
      start = fieldValue(rangePart, spec);
      // “5/15”表示从 5 开始到字段最大值、步长 15（与 croner 一致）。
      end = stepPart === undefined ? start : spec.max;
    }

    for (let value = start; value <= end; value += step) {
      values.add(normalize === undefined ? value : normalize(value));
    }
  }
  if (values.size === 0) throw new Error(`${spec.label}字段没有匹配值`);
  return values;
}

/** 解析 cron 表达式；失败时抛出带中文字段说明的 Error。 */
export function parseCronExpression(expression: string): ParsedCron {
  const text = expression.trim().replace(/\s+/g, ' ');
  if (text.length === 0) throw new Error('请输入 cron 表达式');
  const fields = text.split(' ');
  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error(`cron 表达式需要 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周），当前为 ${fields.length} 段`);
  }
  const hasSeconds = fields.length === 6;
  const [secRaw, minRaw, hourRaw, domRaw, monRaw, dowRaw] = hasSeconds
    ? [fields[0] ?? '', fields[1] ?? '', fields[2] ?? '', fields[3] ?? '', fields[4] ?? '', fields[5] ?? '']
    : ['0', fields[0] ?? '', fields[1] ?? '', fields[2] ?? '', fields[3] ?? '', fields[4] ?? ''];

  const seconds = parseField(secRaw, SECOND_FIELD);
  const minutes = parseField(minRaw, MINUTE_FIELD);
  const hours = parseField(hourRaw, HOUR_FIELD);
  const daysOfMonth = parseField(domRaw, DOM_FIELD);
  const months = parseField(monRaw, MONTH_FIELD);
  const daysOfWeek = parseField(dowRaw, DOW_FIELD, (value) => (value === 7 ? 0 : value));

  return {
    expression: text,
    hasSeconds,
    rawFields: [secRaw, minRaw, hourRaw, domRaw, monRaw, dowRaw],
    seconds,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domWildcard: domRaw === '*' || domRaw === '?',
    dowWildcard: dowRaw === '*' || dowRaw === '?',
  };
}

function matchesDay(date: Date, parsed: ParsedCron): boolean {
  const domMatch = parsed.daysOfMonth.has(date.getDate());
  const dowMatch = parsed.daysOfWeek.has(date.getDay());
  if (parsed.domWildcard && parsed.dowWildcard) return true;
  if (parsed.domWildcard) return dowMatch;
  if (parsed.dowWildcard) return domMatch;
  // 标准 cron：日与星期同时受限时，任一匹配即可。
  return domMatch || dowMatch;
}

const HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000;
const MAX_ITERATIONS = 400_000;

/** 计算未来 N 次运行时间（浏览器本地时区；服务端会按任务时区计算）。 */
export function computeNextRuns(
  expression: string,
  count = 5,
  from: Date = new Date(),
): Date[] {
  const parsed = parseCronExpression(expression);
  const results: Date[] = [];
  if (count <= 0) return results;
  const horizon = from.getTime() + HORIZON_MS;
  let cursor = parsed.hasSeconds
    ? new Date(Math.floor(from.getTime() / 1000) * 1000 + 1000)
    : new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);

  let guard = 0;
  while (results.length < count && guard < MAX_ITERATIONS) {
    guard += 1;
    if (cursor.getTime() > horizon) break;
    if (!parsed.months.has(cursor.getMonth() + 1)) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(cursor, parsed)) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
      continue;
    }
    if (!parsed.hours.has(cursor.getHours())) {
      cursor = new Date(
        cursor.getFullYear(),
        cursor.getMonth(),
        cursor.getDate(),
        cursor.getHours() + 1,
        0,
        0,
        0,
      );
      continue;
    }
    if (!parsed.minutes.has(cursor.getMinutes())) {
      cursor = new Date(
        cursor.getFullYear(),
        cursor.getMonth(),
        cursor.getDate(),
        cursor.getHours(),
        cursor.getMinutes() + 1,
        0,
        0,
      );
      continue;
    }
    if (parsed.hasSeconds && !parsed.seconds.has(cursor.getSeconds())) {
      cursor = new Date(cursor.getTime() + 1000);
      continue;
    }
    results.push(new Date(cursor));
    cursor = parsed.hasSeconds
      ? new Date(cursor.getTime() + 1000)
      : new Date(cursor.getTime() + 60_000);
  }
  return results;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function singleNumber(raw: string): number | null {
  return /^\d{1,2}$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

function describeWeekdays(raw: string): string | null {
  if (raw === '1-5') return '工作日';
  const labels: string[] = [];
  for (const part of raw.split(',')) {
    const normalized = part.trim().toLowerCase();
    const value = singleNumber(part) ?? DOW_NAMES[normalized] ?? null;
    if (value === null) return null;
    const label = DOW_LABEL[value === 7 ? 0 : value];
    if (label === undefined) return null;
    labels.push(label);
  }
  return `每${labels.join('、')}`;
}

function describeDom(raw: string): string | null {
  const labels: string[] = [];
  for (const part of raw.split(',')) {
    const value = singleNumber(part);
    if (value === null) return null;
    labels.push(String(value));
  }
  return labels.join('、');
}

function describeMonths(raw: string): string | null {
  const labels: string[] = [];
  for (const part of raw.split(',')) {
    const value = singleNumber(part);
    if (value === null) {
      const named = MONTH_NAMES[part.trim().toLowerCase()];
      if (named === undefined) return null;
      labels.push(`${named} 月`);
      continue;
    }
    labels.push(`${value} 月`);
  }
  return labels.join('、');
}

interface DescriptionParts {
  /** 时间部分：要么是“每天 HH:mm”，要么是频次描述（每 N 分钟等）。 */
  time: string | null;
  /** HH:mm 形式的精确时刻，用于与星期/日期组合。 */
  clock: string | null;
  minuteSingle: number | null;
  hourSingle: number | null;
}

function describeTime(parsed: ParsedCron): DescriptionParts {
  const [, minRaw, hourRaw] = parsed.rawFields;
  const minuteSingle = singleNumber(minRaw);
  const hourSingle = singleNumber(hourRaw);
  const minuteEvery = /^\*\/(\d+)$/.exec(minRaw);
  const hourEvery = /^\*\/(\d+)$/.exec(hourRaw);
  const clock =
    minuteSingle !== null && hourSingle !== null
      ? `${pad(hourSingle)}:${pad(minuteSingle)}`
      : null;

  if (clock !== null) return { time: `每天 ${clock}`, clock, minuteSingle, hourSingle };
  if (minRaw === '*' && hourRaw === '*') {
    return { time: '每分钟', clock: null, minuteSingle, hourSingle };
  }
  if (minRaw === '*' && hourSingle !== null) {
    return {
      time: `每天 ${pad(hourSingle)} 点内每分钟`,
      clock: null,
      minuteSingle,
      hourSingle,
    };
  }
  if (minuteEvery !== null && hourRaw === '*') {
    return {
      time: `每 ${minuteEvery[1]} 分钟`,
      clock: null,
      minuteSingle,
      hourSingle,
    };
  }
  if (minuteEvery !== null && hourSingle !== null) {
    return {
      time: `每天 ${pad(hourSingle)} 点每 ${minuteEvery[1]} 分钟`,
      clock: null,
      minuteSingle,
      hourSingle,
    };
  }
  if (minuteSingle !== null && hourRaw === '*') {
    return {
      time: minuteSingle === 0 ? '每小时整点' : `每小时第 ${minuteSingle} 分钟`,
      clock: null,
      minuteSingle,
      hourSingle,
    };
  }
  if (minuteSingle !== null && hourEvery !== null) {
    return {
      time: `每 ${hourEvery[1]} 小时的第 ${minuteSingle} 分钟`,
      clock: null,
      minuteSingle,
      hourSingle,
    };
  }
  return { time: null, clock: null, minuteSingle, hourSingle };
}

/** cron → 中文描述；无法解析时返回“无法解析的 cron 表达式”。 */
export function describeCron(expression: string): string {
  let parsed: ParsedCron;
  try {
    parsed = parseCronExpression(expression);
  } catch {
    return looksLikeAdvancedCron(expression)
      ? '高级 cron 表达式（L/W/# 或年字段，由服务端校验）'
      : '无法解析的 cron 表达式';
  }
  const [secRaw, , , domRaw, monRaw, dowRaw] = parsed.rawFields;
  const parts = describeTime(parsed);

  // 秒级特殊符号（秒字段非 0/非 *）优先给出频次描述。
  if (parsed.hasSeconds && parts.time === '每分钟') {
    if (secRaw === '*') return '每秒';
    const secEvery = /^\*\/(\d+)$/.exec(secRaw);
    if (secEvery !== null) return `每 ${secEvery[1]} 秒`;
    const secSingle = singleNumber(secRaw);
    if (secSingle !== null && secSingle !== 0) return `每分钟的第 ${secSingle} 秒`;
  }

  const secondsSuffix =
    parsed.hasSeconds && secRaw !== '0' && secRaw !== '*' && parts.time !== '每分钟'
      ? `（秒字段 ${secRaw}）`
      : '';

  const monthText = parsed.months.size === 12 ? null : describeMonths(monRaw);
  const dowText = parsed.dowWildcard ? null : describeWeekdays(dowRaw);
  const domText = parsed.domWildcard ? null : describeDom(domRaw);
  const exactTime = parts.clock;

  if (!parsed.dowWildcard) {
    if (dowText === null || exactTime === null) {
      return `按 cron 计划（${parsed.expression}）`;
    }
    if (!parsed.domWildcard) {
      const day = domText === null ? domRaw : domText;
      return `每月 ${day} 日或${dowText} ${exactTime}${secondsSuffix}`;
    }
    return `${dowText} ${exactTime}${secondsSuffix}`;
  }

  if (!parsed.domWildcard) {
    if (domText === null || exactTime === null) {
      return `按 cron 计划（${parsed.expression}）`;
    }
    if (monthText !== null) {
      return `每年 ${monthText} ${domText} 日 ${exactTime}${secondsSuffix}`;
    }
    return `每月 ${domText} 日 ${exactTime}${secondsSuffix}`;
  }

  if (monthText !== null) {
    if (exactTime === null && parts.minuteSingle === null) {
      return `按 cron 计划（${parsed.expression}）`;
    }
    return `每年 ${monthText}${parts.time === null ? '' : `，${parts.time}`}${secondsSuffix}`;
  }

  if (parts.time === null) return `按 cron 计划（${parsed.expression}）`;
  return `${parts.time}${secondsSuffix}`;
}

export interface CronValidation {
  valid: boolean;
  error?: string;
  description?: string;
  /** true = croner 高级语法（L/W/#、+AND 或年字段），本地不计算运行时间。 */
  advanced?: boolean;
}

/**
 * 识别 croner 高级语法。服务端使用 croner，支持 L/W/#、+ 与可选年字段；
 * 本地无法完整复现，因此只做“格式大致合理”的放行，最终交给服务端校验。
 */
function looksLikeAdvancedCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/).filter((field) => field.length > 0);
  if (fields.length < 5 || fields.length > 7) return false;
  if (fields.length === 7) return true;
  // 5 段：分 时 日 月 周；6/7 段：秒 分 时 日 月 周 [年]。
  const domIndex = fields.length === 5 ? 2 : 3;
  const dowIndex = fields.length === 5 ? 4 : 5;
  const dom = fields[domIndex] ?? '';
  const dow = fields[dowIndex] ?? '';
  if (/[lw#]/i.test(dom) || /[lw#]/i.test(dow)) return true;
  if (/^\+/.test(dow)) return true;
  return false;
}

/** 实时校验 cron 表达式（语法 + 字段范围）。 */
export function validateCronExpression(expression: string): CronValidation {
  const text = expression.trim();
  if (text.length === 0) return { valid: false, error: '请输入 cron 表达式' };
  if (text.length > 128) return { valid: false, error: 'cron 表达式最长 128 个字符' };
  try {
    parseCronExpression(text);
    return { valid: true, description: describeCron(text), advanced: false };
  } catch (error) {
    if (looksLikeAdvancedCron(text)) {
      return {
        valid: true,
        advanced: true,
        description: '高级 cron 表达式（L/W/# 或年字段，由服务端校验）',
      };
    }
    return {
      valid: false,
      error: error instanceof Error ? error.message : '无法解析 cron 表达式',
    };
  }
}

export interface NextRunsPreviewProps {
  /** 已保存任务 id；有 id 且表达式未改动时优先调用服务端 /tasks/:id/next-runs。 */
  taskId?: string;
  /** 表单中的 cron 表达式（草稿）。 */
  schedule?: string;
  /** 服务端当前保存的表达式；与 schedule 不一致时使用本地预估。 */
  savedSchedule?: string | null;
  timezone?: string | null;
  count?: number;
  className?: string;
}

const BROWSER_TIMEZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '本地时区';
  }
})();

/**
 * 未来运行时间预览。
 * 已保存且表达式未变更时调用服务端 next-runs（含任务时区）；草稿用本地 cron 计算并明确标注。
 */
export function NextRunsPreview(props: NextRunsPreviewProps): JSX.Element {
  const count = props.count ?? 5;
  const schedule = props.schedule;
  const serverEligible =
    props.taskId !== undefined &&
    props.taskId.length > 0 &&
    (schedule === undefined || schedule.trim() === (props.savedSchedule ?? '').trim());

  const serverQuery = useQuery({
    queryKey: tasksKeys.nextRuns(props.taskId ?? 'none', count),
    queryFn: () => getNextRuns(props.taskId as string, count),
    enabled: serverEligible,
    retry: 0,
    staleTime: 5_000,
  });

  const validation = useMemo(
    () => (schedule === undefined ? null : validateCronExpression(schedule)),
    [schedule],
  );

  const localRuns = useMemo(() => {
    if (schedule === undefined || validation === null || !validation.valid) return [];
    if (validation.advanced === true) return [];
    try {
      return computeNextRuns(schedule, count);
    } catch {
      return [];
    }
  }, [schedule, count, validation]);

  const serverRuns = serverQuery.data?.nextRuns.map((item) => item.at) ?? null;
  const useServer = serverEligible && serverRuns !== null;
  const serverError =
    serverEligible && serverQuery.error !== null && serverQuery.error !== undefined
      ? describeError(serverQuery.error)
      : null;

  const localTimes = localRuns.map((date) => date.toISOString());
  const times = useServer ? serverRuns : localTimes;
  const description = schedule === undefined ? null : describeCron(schedule);
  const timezoneNote =
    !useServer &&
    props.timezone !== undefined &&
    props.timezone !== null &&
    props.timezone.length > 0 &&
    props.timezone !== BROWSER_TIMEZONE
      ? `本地预估按浏览器时区（${BROWSER_TIMEZONE}）计算；保存后服务端按 ${props.timezone} 计算。`
      : null;

  return (
    <div
      className={cn(
        'rounded-lg border border-app-border bg-app-elevated/40 px-3 py-2.5',
        props.className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <CalendarClock className="h-3.5 w-3.5 text-app-muted" />
          <span className="text-xs font-medium text-app-text">未来 {count} 次运行</span>
          {useServer ? (
            <Badge tone="accent" className="px-1.5 py-0 text-[10px]" title="来自 GET /tasks/:id/next-runs">
              服务端计算
            </Badge>
          ) : (
            <Badge tone="neutral" className="px-1.5 py-0 text-[10px]" title="草稿表达式由浏览器本地计算">
              本地预估
            </Badge>
          )}
        </div>
        {serverEligible ? (
          <Button
            variant="ghost"
            size="xs"
            icon={<RefreshCw className={cn('h-3 w-3', serverQuery.isFetching ? 'animate-spin' : '')} />}
            onClick={() => {
              void serverQuery.refetch();
            }}
            disabled={serverQuery.isFetching}
          >
            刷新
          </Button>
        ) : null}
      </div>

      {schedule !== undefined && schedule.trim().length > 0 && validation !== null && !validation.valid ? (
        <p className="mt-1.5 text-xs text-app-danger" role="alert">
          {validation.error ?? 'cron 表达式无效'}
        </p>
      ) : null}

      {serverEligible && serverQuery.isLoading ? (
        <Skeleton lines={3} className="mt-2" />
      ) : null}

      {schedule === undefined && !serverEligible ? (
        <p className="mt-1.5 text-xs text-app-muted">保存任务后可查看服务端计算的运行时间。</p>
      ) : null}

      {schedule !== undefined && schedule.trim().length === 0 && !serverEligible ? (
        <p className="mt-1.5 text-xs text-app-muted">填写 cron 表达式后显示运行时间。</p>
      ) : null}

      {validation?.advanced === true && !useServer ? (
        <p className="mt-1.5 text-xs text-app-muted">
          高级 cron 表达式（L/W/#、+AND 或年字段）无法在本地预估；保存后由服务端计算并展示。
        </p>
      ) : null}

      {times.length > 0 ? (
        <ol className="mt-2 flex flex-col gap-1">
          {times.map((time, index) => (
            <li key={`${time}-${index}`} className="flex items-center justify-between gap-2 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-app-border/60 text-[10px] tabular-nums text-app-muted">
                  {index + 1}
                </span>
                <span className="truncate tabular-nums text-app-text" title={time}>
                  {formatDate(time)}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-app-muted">{formatRelativeTime(time)}</span>
            </li>
          ))}
        </ol>
      ) : schedule !== undefined && validation?.valid === true && validation.advanced !== true && !serverQuery.isLoading ? (
        <p className="mt-1.5 text-xs text-app-warning">
          {serverEligible && serverError === null
            ? '服务端未返回运行时间；请检查表达式与时区。'
            : '未来 5 年内没有匹配的运行时间，请检查表达式。'}
        </p>
      ) : null}

      {description !== null && validation?.valid === true ? (
        <p className="mt-1.5 text-[11px] text-app-muted">计划说明：{description}</p>
      ) : null}

      {serverError !== null ? (
        <p className="mt-1.5 text-[11px] text-app-warning">
          服务端预览失败：{serverError.title} · {serverError.description}
          {schedule === undefined ? '' : '（已回退为本地预估，仅供参考）'}
        </p>
      ) : null}

      {timezoneNote === null ? null : <p className="mt-1 text-[11px] text-app-warning">{timezoneNote}</p>}

      {useServer ? (
        <p className="mt-1 text-[11px] text-app-muted">
          服务端按任务时区{props.timezone === undefined || props.timezone === null || props.timezone.length === 0
            ? '（未设置时区时使用 agent 本地时区）'
            : ` ${props.timezone}`}
          计算，实际调度以服务端为准。
        </p>
      ) : null}
    </div>
  );
}
