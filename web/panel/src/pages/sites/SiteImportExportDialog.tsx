import { useEffect, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { exportSites, importSites, sitesKeys } from '../../api/sites';
import type { SiteExportBundle, SiteImportResult } from '../../api/types';
import { AppError, describeError } from '../../api/errors';
import { downloadText } from '../../lib/download';
import { useAppMutation } from '../../lib/mutations';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { CodeEditor } from '../../components/ui/CodeEditor';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';
import { Tabs } from '../../components/ui/Tabs';

export interface SiteImportExportDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 站点导出/导入（SiteExportBundle JSON）。
 * 契约明确不支持原始 Caddyfile 导入：Caddyfile 由结构化配置单向生成。
 */
export function SiteImportExportDialog(props: SiteImportExportDialogProps): JSX.Element {
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const [bundle, setBundle] = useState<SiteExportBundle | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const [importText, setImportText] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<SiteImportResult | null>(null);

  useEffect(() => {
    if (!props.open) {
      setBundle(null);
      setExportError(null);
      setImportText('');
      setParseError(null);
      setResult(null);
    }
  }, [props.open]);

  const runExport = async (): Promise<void> => {
    setExporting(true);
    setExportError(null);
    try {
      const data = await exportSites();
      setBundle(data);
    } catch (error) {
      setExportError(error);
    } finally {
      setExporting(false);
    }
  };

  const importMutation = useAppMutation({
    mutationFn: async (parsed: SiteExportBundle) => {
      if (parsed.version !== 1) {
        throw new AppError('BAD_REQUEST', '不支持的站点包版本', 0, {
          hint: '只支持 version=1 的 SiteExportBundle。',
        });
      }
      if (!Array.isArray(parsed.sites)) {
        throw new AppError('BAD_REQUEST', '站点包缺少 sites 数组', 0, {
          hint: '请使用“导出”得到的 JSON 文件。',
        });
      }
      return importSites({ bundle: parsed, mode });
    },
    successMessage: (data) => `导入完成：新增 ${data.imported}，跳过 ${data.skipped}`,
    invalidate: [sitesKeys.list()],
    onSuccess: (data) => {
      setResult(data);
      setImportText('');
    },
  });

  const submitImport = (): void => {
    setParseError(null);
    setResult(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      setParseError('JSON 解析失败，请检查文件内容。');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      setParseError('站点包必须是 JSON 对象。');
      return;
    }
    importMutation.mutate(parsed as SiteExportBundle);
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    try {
      setImportText(await file.text());
      setParseError(null);
    } catch {
      setParseError('无法读取文件。');
    }
  };

  const exportJson = bundle === null ? '' : JSON.stringify(bundle, null, 2);

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="导入 / 导出站点"
      description="导入导出的是结构化站点包（SiteExportBundle），不是 Caddyfile 原文。"
      size="xl"
      footer={
        <>
          {tab === 'export' ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Download className="h-3.5 w-3.5" />}
              loading={exporting}
              onClick={() => void runExport()}
            >
              生成站点包
            </Button>
          ) : (
            <Button
              size="sm"
              icon={<Upload className="h-3.5 w-3.5" />}
              loading={importMutation.isPending}
              disabled={importText.trim().length === 0}
              onClick={submitImport}
            >
              开始导入
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            关闭
          </Button>
        </>
      }
    >
      <Tabs
        tabs={[
          { id: 'export', label: '导出' },
          { id: 'import', label: '导入' },
        ]}
        active={tab}
        onChange={(id) => setTab(id === 'import' ? 'import' : 'export')}
        className="mb-3"
      />

      {tab === 'export' ? (
        <div className="flex flex-col gap-3">
          <Alert tone="info" title="导出内容">
            包含全部站点（含禁用）的 name/enabled/config，不含 id、revision 与运行状态。
          </Alert>
          {exportError === null ? null : <Alert tone="danger" title="导出失败">{describeError(exportError).description}</Alert>}
          {exporting ? (
            <div className="flex min-h-[160px] items-center justify-center">
              <Spinner label="读取站点…" />
            </div>
          ) : bundle === null ? (
            <p className="text-xs text-app-muted">点击“生成站点包”读取当前站点。</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  icon={<Download className="h-3.5 w-3.5" />}
                  onClick={() =>
                    downloadText(
                      exportJson,
                      `mpanel-sites-${new Date().toISOString().slice(0, 10)}.json`,
                    )
                  }
                >
                  下载 JSON
                </Button>
                <span className="text-xs text-app-muted">
                  {bundle.sites.length} 个站点 · 导出于 {bundle.exportedAt}
                </span>
              </div>
              <CodeEditor value={exportJson} readOnly language="json" height="340px" />
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Alert tone="warning" title="不支持粘贴 Caddyfile">
            api-contract §6.1 规定原始 Caddyfile 导入不受支持：站点只接受结构化配置，Caddyfile 由服务端单向生成。
            请导入由本面板导出的 JSON 站点包。
          </Alert>

          <div className="flex flex-wrap items-end gap-3">
            <FormField label="模式" className="w-48">
              <Select
                value={mode}
                onChange={(event) => setMode(event.target.value === 'replace' ? 'replace' : 'merge')}
                options={[
                  { value: 'merge', label: 'merge · 同名跳过' },
                  { value: 'replace', label: 'replace · 删除现有后导入' },
                ]}
              />
            </FormField>
            <FormField label="选择 JSON 文件">
              <input
                type="file"
                accept="application/json,.json"
                className="text-xs text-app-muted file:mr-2 file:rounded-md file:border file:border-app-border file:bg-app-elevated file:px-2 file:py-1 file:text-xs file:text-app-text"
                onChange={(event) => {
                  void onFile(event.target.files?.[0]);
                }}
              />
            </FormField>
          </div>

          <FormField
            label="站点包 JSON"
            hint="导入前会整体校验；任何无效站点都会导致 400，且不会写入。"
            error={parseError}
          >
            <textarea
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              rows={12}
              placeholder='{"version":1,"exportedAt":"…","sites":[…] }'
              className="w-full rounded-md border border-app-border bg-app-surface px-3 py-2 font-mono text-xs text-app-text focus:border-app-accent focus:outline-none"
            />
          </FormField>

          {result === null ? null : (
            <Alert tone={result.errors.length > 0 ? 'warning' : 'success'} title="导入结果">
              新增 {result.imported} 个，跳过 {result.skipped} 个
              {result.errors.length === 0 ? '。' : '，错误：'}
              {result.errors.length === 0 ? null : (
                <ul className="mt-1 list-disc pl-4">
                  {result.errors.map((item) => (
                    <li key={`${item.index}-${item.name ?? ''}`}>
                      #{item.index} {item.name ?? ''}：{item.message}
                    </li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
          <p className="text-xs text-app-muted">
            导入只写 JSON 草稿，不会自动 apply；需要到列表页点击“应用全部更改”才会写入 Caddy。
          </p>
        </div>
      )}
    </Modal>
  );
}
