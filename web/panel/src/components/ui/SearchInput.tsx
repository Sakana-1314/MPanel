import { Search, X } from 'lucide-react';
import { Input } from './Input';
import { cn } from '../../lib/cn';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** 回车触发（服务端搜索）。 */
  onSubmit?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
}

export function SearchInput(props: SearchInputProps): JSX.Element {
  return (
    <Input
      type="search"
      value={props.value}
      placeholder={props.placeholder ?? '搜索…'}
      autoFocus={props.autoFocus}
      disabled={props.disabled}
      aria-label={props.placeholder ?? '搜索'}
      className={cn('w-56', props.className)}
      leading={<Search className="h-3.5 w-3.5" />}
      trailing={
        props.value.length === 0 ? undefined : (
          <button
            type="button"
            onClick={() => props.onChange('')}
            className="rounded p-0.5 text-app-muted hover:bg-app-elevated hover:text-app-text"
            aria-label="清空搜索"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )
      }
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') props.onSubmit?.();
      }}
    />
  );
}
