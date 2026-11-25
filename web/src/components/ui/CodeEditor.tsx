import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { sql } from '@codemirror/lang-sql';
import { cn } from '../../lib/cn';
import { useTheme } from '../../app/ThemeProvider';

export type CodeLanguage = 'caddyfile' | 'text' | 'sql' | 'json';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: string;
  placeholder?: string;
  language?: CodeLanguage;
  className?: string;
  ariaLabel?: string;
  /** 行号，默认显示。 */
  lineNumbers?: boolean;
}

/**
 * CodeMirror 封装：caddyfile/text 使用纯文本，sql/json 使用对应语言包。
 * 主题跟随全局 ThemeProvider（深色优先）。
 */
export function CodeEditor(props: CodeEditorProps): JSX.Element {
  const { theme } = useTheme();
  const language = props.language ?? 'text';

  const extensions = useMemo(() => {
    if (language === 'json') return [json()];
    if (language === 'sql') return [sql()];
    return [];
  }, [language]);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-app-border bg-app-surface',
        props.className,
      )}
    >
      <CodeMirror
        value={props.value}
        height={props.height ?? '320px'}
        theme={theme}
        extensions={extensions}
        readOnly={props.readOnly === true}
        editable={props.readOnly !== true}
        placeholder={props.placeholder}
        basicSetup={{
          lineNumbers: props.lineNumbers !== false,
          foldGutter: false,
          highlightActiveLine: props.readOnly !== true,
          highlightActiveLineGutter: props.readOnly !== true,
          autocompletion: props.readOnly !== true,
        }}
        onChange={(value) => props.onChange?.(value)}
        aria-label={props.ariaLabel ?? '代码编辑器'}
      />
    </div>
  );
}
