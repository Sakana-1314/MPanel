import type { ReactNode } from 'react';

/* ---------------------------------- 基础 --------------------------------- */

export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';
export { Input } from './Input';
export type { InputProps } from './Input';
export { Textarea } from './Textarea';
export type { TextareaProps } from './Textarea';
export { Select } from './Select';
export type { SelectOption, SelectProps } from './Select';
export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox';
export { Switch } from './Switch';
export type { SwitchProps } from './Switch';
export { FormField } from './FormField';
export type { FormFieldProps } from './FormField';

/* ------------------------------- 反馈与状态 ------------------------------ */

export { Badge } from './Badge';
export type { BadgeProps } from './Badge';
export { StatusBadge } from './StatusBadge';
export type { StatusBadgeProps } from './StatusBadge';
export { StatusDot } from './StatusDot';
export type { StatusDotProps, StatusDotStatus } from './StatusDot';
export { Alert, UnavailableAlert } from './Alert';
export type { AlertProps, AlertTone, UnavailableAlertProps } from './Alert';
export { Spinner } from './Spinner';
export type { SpinnerProps } from './Spinner';
export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';
export { ErrorState, InlineError, Skeleton, LoadingSkeleton } from './ErrorState';
export type { ErrorStateProps, SkeletonProps, LoadingSkeletonProps } from './ErrorState';
export { CapabilityNotice } from './CapabilityNotice';
export type { CapabilityNoticeProps } from './CapabilityNotice';

/* -------------------------------- 容器/布局 ------------------------------- */

export { Card, CardHeader, CardBody, StatCard } from './Card';
export type { CardProps, CardHeaderProps, CardBodyProps, StatCardProps } from './Card';
export { PageHeader } from './PageHeader';
export type { PageHeaderProps } from './PageHeader';
export { Toolbar } from './Toolbar';
export type { ToolbarProps } from './Toolbar';
export { Tabs } from './Tabs';
export type { TabsProps, TabItem } from './Tabs';
export { Modal } from './Modal';
export type { ModalProps, ModalSize } from './Modal';
export { Drawer } from './Drawer';
export type { DrawerProps, DrawerSize } from './Drawer';
export { ConfirmDialog } from './ConfirmDialog';
export type { ConfirmDialogProps } from './ConfirmDialog';

/* --------------------------------- 数据展示 ------------------------------ */

export { DataTable } from './DataTable';
export type { Column, DataTableProps, SortDirection, SortState } from './DataTable';
export { Pagination } from './Pagination';
export type { PaginationProps } from './Pagination';
export { SearchInput } from './SearchInput';
export type { SearchInputProps } from './SearchInput';
export { RelativeTime } from './RelativeTime';
export type { RelativeTimeProps } from './RelativeTime';
export { FileIcon } from './FileIcon';
export type { FileIconProps } from './FileIcon';
export { LogViewer } from './LogViewer';
export type { LogLine, LogViewerProps } from './LogViewer';

/* ---------------------------------- 代码 --------------------------------- */

export { CodeBlock } from './CodeBlock';
export type { CodeBlockProps } from './CodeBlock';
export { CodeEditor } from './CodeEditor';
export type { CodeEditorProps, CodeLanguage } from './CodeEditor';

/* ---------------------------------- 其他 --------------------------------- */

export { CopyButton } from './CopyButton';
export type { CopyButtonProps } from './CopyButton';
export { Tooltip } from './Tooltip';
export type { TooltipProps } from './Tooltip';
export { SecretReveal } from './SecretReveal';
export type { SecretRevealProps } from './SecretReveal';
export { ToastProvider, useToast } from './Toast';
export type { ToastApi, ToastInput, ToastTone } from './Toast';
export { statusLabel, statusTone, TONE_CLASS } from './tones';
export type { StatusTone } from './tones';

export type UiChild = ReactNode;
