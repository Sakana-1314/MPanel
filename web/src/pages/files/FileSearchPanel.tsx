import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { FileItem } from '../../api/types';
import { readFile, searchFiles } from '../../api/files';
import { scopedKey } from '../../lib/query-keys';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Drawer } from '../../components/ui/Drawer';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { FileIcon } from '../../components/ui/FileIcon';
import { FormField } from '../../components/ui/FormField';
import { SearchInput } from '../../components/ui/SearchInput';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { UnavailableAlert } from '../../components/ui/Alert';
import { parentVirtualPath } from './Breadcrumbs';

const MAX_RESULTS = 200;
/** 内容搜索的行号/片段由前端读取命中文件计算，限制数量与读取大小。 */
const SNIPPET_LIMIT_FILES = 40;
const SNIPPET_MAX_BYTES = 1024 * 1024;
const SNIPPET_MAX_CHARS = 180;

interface SnippetMatch {
  line: number;
  snippet: string;
}

/**
 * 后端按 FileItem 返回结果；内容搜索若附带行号/片段，前端容忍以下字段名。
 * 契约未定义这些字段时，退化为读取命中文件计算首个匹配的行号与整行片段。
 */
interface SearchHit extends FileItem {
  line?: number;
  lineNumber?: number;
  snippet?: string;
  preview?: string;
  match?: string;
  text?: string;
}

function hitLine(hit: SearchHit): number | null {
  const value = hit.line ?? hit.lineNumber;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hitSnippet(hit: SearchHit): string | null {
  const value = hit.snippet ?? hit.preview ?? hit.match ?? hit.text;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** 在文件内容中查找首个匹配，返回 1 起始行号与整行片段。 */
function findSnippet(content: string, needle: string, caseSensitive: boolean): SnippetMatch | null {
  if (needle.length === 0) return null;
  const haystack = caseSensitive ? content : content.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  const index = haystack.indexOf(target);
  if (index < 0) return null;
  const before = content.slice(0, index);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const newline = content.indexOf('\n', index);
  const lineEnd = newline < 0 ? content.length : newline;
  const lineText = content.slice(lineStart, lineEnd).replace(/\r$/, '');
  if (lineText.length <= SNIPPET_MAX_CHARS) {
    return { line, snippet: lineText.trim() };
  }
  const column = index - lineStart;
  const offset = Math.max(0, column - Math.floor(SNIPPET_MAX_CHARS / 2));
  const prefix = offset > 0 ? '…' : '';
  const suffix = offset + SNIPPET_MAX_CHARS < lineText.length ? '…' : '';
  return {
    line,
    snippet: `${prefix}${lineText.slice(offset, offset + SNIPPET_MAX_CHARS)}${suffix}`,
  };
}

export interface FileSearchPanelProps {
  root: string;
  path: string;
  onClose(): void;
  onOpen(item: FileItem): void;
}

/** 文件名 glob / 内容搜索；结果显示路径、行号与片段（若后端提供）。 */
export function FileSearchPanel(props: FileSearchPanelProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [mode, setMode] = useState<'name' | 'content'>('name');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [wholeRoot, setWholeRoot] = useState(false);

  const searchQuery = useQuery({
    queryKey: scopedKey('files', 'search', {
      root: props.root,
      path: wholeRoot ? null : props.path,
      q: submitted,
      mode,
      caseSensitive,
      includeHidden,
    }),
    queryFn: () =>
      searchFiles({
        root: props.root,
        path: wholeRoot ? undefined : props.path,
        q: submitted,
        mode,
        caseSensitive,
        includeHidden,
        limit: MAX_RESULTS,
      }),
    enabled: submitted.length > 0,
    retry: 0,
  });

  const runSearch = (): void => {
    const value = query.trim();
    if (value.length === 0) {
      setQuery('');
      setSubmitted('');
      return;
    }
    if (value === submitted) {
      void searchQuery.refetch();
      return;
    }
    setSubmitted(value);
  };

  const hits = (searchQuery.data?.items ?? []) as SearchHit[];
  const truncated = searchQuery.data?.truncated === true;
  const contentMode = mode === 'content';

  /* 内容搜索：后端只返回命中的 FileItem，行号/片段在前端读取文件计算。 */
  const [snippets, setSnippets] = useState<Record<string, SnippetMatch>>({});
  const [snippetLoading, setSnippetLoading] = useState(false);

  useEffect(() => {
    if (!contentMode || searchQuery.data === undefined) {
      setSnippets({});
      setSnippetLoading(false);
      return;
    }
    let cancelled = false;
    const targets = searchQuery.data.items
      .filter((item) => item.type === 'file' && item.size > 0 && item.size <= SNIPPET_MAX_BYTES)
      .slice(0, SNIPPET_LIMIT_FILES);
    setSnippets({});
    setSnippetLoading(targets.length > 0);
    const run = async (): Promise<void> => {
      for (const item of targets) {
        if (cancelled) return;
        try {
          const data = await readFile({
            root: props.root,
            path: item.path,
            encoding: 'utf8',
            maxBytes: SNIPPET_MAX_BYTES,
          });
          if (cancelled) return;
          if (data.isBinary) continue;
          const match = findSnippet(data.content, submitted, caseSensitive);
          if (match !== null) {
            setSnippets((prev) => ({ ...prev, [item.path]: match }));
          }
        } catch {
          // 单个文件读取失败时保留“未提取片段”，不影响其余结果。
        }
      }
      if (!cancelled) setSnippetLoading(false);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [contentMode, searchQuery.data, submitted, caseSensitive, props.root]);

  const contentHits = contentMode && searchQuery.data !== undefined ? searchQuery.data.items : [];
  const eligibleHits = contentHits.filter(
    (item) => item.type === 'file' && item.size > 0 && item.size <= SNIPPET_MAX_BYTES,
  );
  const unenrichedCount = contentHits.length - eligibleHits.length;
  const beyondLimitCount = Math.max(0, eligibleHits.length - SNIPPET_LIMIT_FILES);

  const columns: Column<SearchHit>[] = [
    {
      key: 'name',
      header: '文件',
      render: (hit) => (
        <div className="flex min-w-0 items-center gap-2">
          <FileIcon type={hit.type} name={hit.name} />
          <div className="min-w-0">
            <p className="truncate text-sm text-app-text" title={hit.path}>
              {hit.name}
            </p>
            <p className="truncate font-mono text-[10px] text-app-muted">
              {parentVirtualPath(hit.path)}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'line',
      header: '行号',
      width: 72,
      align: 'right',
      render: (hit) => {
        if (!contentMode) return <span className="text-xs text-app-muted">—</span>;
        const line = hitLine(hit) ?? snippets[hit.path]?.line ?? null;
        if (line !== null) {
          return <span className="font-mono text-xs text-app-accent">{line}</span>;
        }
        return (
          <span className="text-[10px] text-app-muted">
            {snippetLoading && hit.type === 'file' && hit.size <= SNIPPET_MAX_BYTES ? '…' : '—'}
          </span>
        );
      },
    },
    {
      key: 'snippet',
      header: '匹配片段',
      render: (hit) => {
        if (!contentMode) return <span className="text-xs text-app-muted">—</span>;
        const snippet = hitSnippet(hit) ?? snippets[hit.path]?.snippet ?? null;
        if (snippet !== null) {
          return (
            <code className="block max-h-12 overflow-hidden whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-app-text">
              {snippet}
            </code>
          );
        }
        if (snippetLoading && hit.type === 'file' && hit.size <= SNIPPET_MAX_BYTES) {
          return <span className="text-xs text-app-muted">提取片段中…</span>;
        }
        if (hit.type !== 'file') {
          return <span className="text-xs text-app-muted">仅文件可提取内容片段</span>;
        }
        if (hit.size > SNIPPET_MAX_BYTES) {
          return (
            <span className="text-xs text-app-muted">文件超过 1 MiB，未提取片段</span>
          );
        }
        return <span className="text-xs text-app-muted">未在文件前 1 MiB 内找到匹配</span>;
      },
    },
    {
      key: 'type',
      header: '类型',
      width: 84,
      render: (hit) => (
        <Badge tone={hit.type === 'directory' ? 'accent' : 'neutral'}>
          {hit.type === 'directory' ? '目录' : hit.type === 'symlink' ? '链接' : '文件'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 78,
      render: (hit) => (
        <Button
          variant="secondary"
          size="xs"
          onClick={(event) => {
            event.stopPropagation();
            props.onOpen(hit);
          }}
        >
          定位
        </Button>
      ),
    },
  ];

  const empty =
    submitted.length === 0 ? (
      <EmptyState
        compact
        icon={<Search className="h-5 w-5" />}
        title="输入关键字开始搜索"
        description="文件名模式支持 glob（如 *.log、*.{ts,tsx}）；内容搜索只扫描文本文件（≤5 MiB），最多返回 200 条。"
      />
    ) : (
      <EmptyState
        compact
        title="没有匹配结果"
        description={
          includeHidden
            ? '可尝试更换关键字、切换搜索模式或扩大搜索范围。'
            : '隐藏文件未被搜索；可打开“包含隐藏文件”后重试。'
        }
      />
    );

  return (
    <Drawer
      open
      onClose={props.onClose}
      title="搜索文件"
      description={`范围：${props.root}:${wholeRoot ? '/' : props.path}`}
      size="xl"
      footer={
        <>
          <span className="mr-auto text-xs text-app-muted">
            {searchQuery.data === undefined ? '尚未搜索' : `共 ${hits.length} 条结果`}
          </span>
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            关闭
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <FormField label="关键字 / glob 模式">
              <SearchInput
                value={query}
                onChange={setQuery}
                onSubmit={runSearch}
                placeholder={mode === 'name' ? '例如 *.log 或 config.*' : '要查找的文本内容'}
                autoFocus
                className="w-full"
              />
            </FormField>
          </div>
          <Button
            variant="primary"
            size="md"
            icon={<Search className="h-4 w-4" />}
            onClick={runSearch}
            loading={searchQuery.isFetching}
          >
            搜索
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-4 rounded-lg border border-app-border bg-app-surface px-3 py-2">
          <FormField label="模式" className="w-44">
            <Select
              value={mode}
              onChange={(event) => {
                const next = event.target.value === 'content' ? 'content' : 'name';
                setMode(next);
              }}
              options={[
                { value: 'name', label: '按文件名（glob）' },
                { value: 'content', label: '按内容' },
              ]}
            />
          </FormField>
          <Switch checked={caseSensitive} onChange={setCaseSensitive} label="区分大小写" />
          <Switch checked={includeHidden} onChange={setIncludeHidden} label="包含隐藏文件" />
          <Switch checked={wholeRoot} onChange={setWholeRoot} label="搜索整个根目录" />
        </div>

        {contentMode ? (
          <Alert tone="info" title="内容搜索">
            仅搜索文本文件（单文件 ≤5 MiB）；二进制与过大文件会被跳过。结果上限 {MAX_RESULTS} 条。
          </Alert>
        ) : (
          <Alert tone="info" title="文件名搜索">
            {'支持 glob 通配符（*、?、[]、{a,b}），匹配当前目录或整个根目录；隐藏文件默认不搜索。'}
          </Alert>
        )}

        {contentMode && (beyondLimitCount > 0 || unenrichedCount > 0) ? (
          <Alert tone="neutral" title="行号/片段提取范围">
            {`行号与片段由前端读取命中文件的前 ${Math.round(SNIPPET_MAX_BYTES / (1024 * 1024))} MiB 计算，最多处理 ${SNIPPET_LIMIT_FILES} 个文件。`}
            {beyondLimitCount > 0 ? ` 另有 ${beyondLimitCount} 个匹配未提取片段。` : ''}
            {unenrichedCount > 0
              ? ` ${unenrichedCount} 个命中不是普通文件或超过 1 MiB，未提取片段。`
              : ''}
          </Alert>
        ) : null}

        {searchQuery.data?.available === false ? (
          <UnavailableAlert
            available={false}
            reason={searchQuery.data.reason ?? '后端报告文件搜索不可用。'}
            title="文件搜索不可用"
          />
        ) : null}

        {truncated ? (
          <Alert tone="warning" title="结果已截断" hint="仅展示前 200 条匹配；请缩小搜索范围或使用更精确的模式。">
            匹配项超过上限，当前列表不完整。
          </Alert>
        ) : null}

        {searchQuery.error !== null ? (
          <ErrorState
            error={searchQuery.error}
            title="搜索失败"
            onRetry={() => void searchQuery.refetch()}
          />
        ) : null}

        <DataTable
          columns={columns}
          rows={hits}
          rowKey={(hit) => `${hit.root}:${hit.path}:${String(hitLine(hit) ?? 0)}`}
          loading={searchQuery.isLoading}
          empty={empty}
          onRowClick={props.onOpen}
          dense
          footer={
            <span className="text-[11px] text-app-muted">
              点击结果定位到所在目录；目录结果会直接进入该目录。
            </span>
          }
        />
      </div>
    </Drawer>
  );
}
