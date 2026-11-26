<script lang="ts">
import { computed, defineComponent, h } from 'vue';
import { RouterView } from 'vue-router';
import {
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NNotificationProvider,
  dateZhCN,
  darkTheme,
  zhCN,
  type GlobalThemeOverrides,
} from 'naive-ui';
import { useTheme } from './lib/theme';

const fontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif';

const baseCommon = {
  fontFamily,
  fontFamilyMono:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontWeightStrong: '600',
  borderRadius: '6px',
  borderRadiusSmall: '6px',
};

const lightOverrides: GlobalThemeOverrides = {
  common: {
    ...baseCommon,
    primaryColor: '#2563eb',
    primaryColorHover: '#3b82f6',
    primaryColorPressed: '#1d4ed8',
    primaryColorSuppl: '#3b82f6',
    // 语义色统一收进蓝色与灰阶：警告/错误只用灰字与浅底，不引入红黄绿。
    infoColor: '#2563eb',
    successColor: '#2563eb',
    warningColor: 'rgba(51, 54, 57, 0.78)',
    // 错误态同样走中性色：最深一档灰，配加粗字重表达强调。
    errorColor: '#14181f',
    bodyColor: '#f3f5fa',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    tableColor: '#ffffff',
    inputColor: '#eef1f7',
    actionColor: '#eef1f7',
    tableHeaderColor: '#eef1f7',
    tableColorStriped: 'rgba(15, 23, 42, 0.02)',
    borderColor: 'rgba(15, 23, 42, 0.1)',
    dividerColor: 'rgba(15, 23, 42, 0.07)',
    textColorBase: '#14181f',
    textColor1: '#14181f',
    textColor2: '#14181f',
    textColor3: 'rgba(51, 54, 57, 0.78)',
    textColorDisabled: 'rgba(51, 54, 57, 0.68)',
    placeholderColor: 'rgba(51, 54, 57, 0.78)',
    hoverColor: 'rgba(15, 23, 42, 0.05)',
    boxShadow1: '0 1px 2px rgba(15, 23, 42, 0.04)',
    boxShadow2: '0 2px 8px rgba(15, 23, 42, 0.08)',
    boxShadow3: '0 8px 28px rgba(15, 23, 42, 0.12)',
  },
  // 侧栏与顶栏都用白底，与内容区（浅灰）形成一块面而不是一条线。
  Layout: { siderColor: '#ffffff', headerColor: '#ffffff', color: '#f3f5fa' },
  Card: {
    borderRadius: '12px',
    paddingSmall: '14px 16px',
    color: '#ffffff',
    borderColor: 'transparent',
    colorEmbedded: '#eef1f7',
    actionColor: '#eef1f7',
  },
  Button: { borderRadiusMedium: '8px', borderRadiusSmall: '8px', fontWeight: '500' },
  Input: { borderRadius: '8px', color: '#eef1f7', colorFocus: '#ffffff' },
  DataTable: { borderRadius: '12px', thColor: '#eef1f7', tdColor: '#ffffff', borderColor: 'rgba(15, 23, 42, 0.07)' },
  Table: {
    borderRadius: '12px',
    thColor: '#eef1f7',
    tdColor: '#ffffff',
    borderColor: 'rgba(15, 23, 42, 0.07)',
  },
  Tabs: {
    tabColorSegment: '#ffffff',
    colorSegment: '#eef1f7',
    tabBorderRadius: '8px',
    tabTextColorLine: 'rgba(51, 54, 57, 0.78)',
    tabTextColorActiveLine: '#14181f',
    tabTextColorHoverLine: '#14181f',
    tabFontWeightActive: '600',
    paneTextColor: '#14181f',
  },
  Alert: {
    borderRadius: '12px',
    // Alert 的错误色在组件内部由 errorColor 推导，需显式覆盖为中性色。
    borderError: '1px solid transparent',
    colorError: 'rgba(15, 23, 42, 0.06)',
    iconColorError: '#14181f',
    titleTextColorError: '#14181f',
    contentTextColorError: 'rgba(51, 54, 57, 0.9)',
  },
  Tag: {
    borderRadius: '999px',
    // 状态标签只保留蓝/灰：成功与信息同为蓝色，提醒、默认、错误都用灰。
    textColorSuccess: '#1d4ed8',
    textColorInfo: '#1d4ed8',
    colorSuccess: 'rgba(37, 99, 235, 0.1)',
    colorInfo: 'rgba(37, 99, 235, 0.1)',
    textColorWarning: 'rgba(51, 54, 57, 0.78)',
    colorWarning: 'rgba(15, 23, 42, 0.06)',
    textColorDefault: 'rgba(51, 54, 57, 0.78)',
    textColorError: '#14181f',
    colorError: 'rgba(15, 23, 42, 0.08)',
  },
  Drawer: { headerBorderBottom: '0 solid transparent', footerBorderTop: '0 solid transparent', color: '#ffffff' },
  Descriptions: { thColor: 'transparent', tdColor: '#ffffff', borderColor: 'transparent' },
};

const darkOverrides: GlobalThemeOverrides = {
  common: {
    ...baseCommon,
    primaryColor: '#3b82f6',
    primaryColorHover: '#60a5fa',
    primaryColorPressed: '#2563eb',
    primaryColorSuppl: '#3b82f6',
    infoColor: '#3b82f6',
    successColor: '#3b82f6',
    warningColor: 'rgba(255, 255, 255, 0.72)',
    errorColor: '#f2f4f8',
    bodyColor: '#0a0a0d',
    cardColor: '#1a1a20',
    modalColor: '#202028',
    popoverColor: '#24242c',
    tableColor: '#1a1a20',
    inputColor: '#121216',
    actionColor: '#121216',
    tableHeaderColor: '#121216',
    tableColorStriped: 'rgba(255, 255, 255, 0.02)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    dividerColor: 'rgba(255, 255, 255, 0.06)',
    textColorBase: '#f2f4f8',
    textColor1: '#f2f4f8',
    textColor2: '#f2f4f8',
    textColor3: 'rgba(255, 255, 255, 0.72)',
    textColorDisabled: 'rgba(255, 255, 255, 0.55)',
    placeholderColor: 'rgba(255, 255, 255, 0.68)',
    hoverColor: 'rgba(255, 255, 255, 0.07)',
    boxShadow1: '0 1px 2px rgba(0, 0, 0, 0.35)',
    boxShadow2: '0 4px 16px rgba(0, 0, 0, 0.45)',
    boxShadow3: '0 12px 36px rgba(0, 0, 0, 0.55)',
  },
  // 深色下侧栏与顶栏仍取卡片色，比页底亮一档。
  Layout: { siderColor: '#1a1a20', headerColor: '#1a1a20', color: '#0a0a0d' },
  Card: {
    borderRadius: '12px',
    paddingSmall: '14px 16px',
    color: '#1a1a20',
    borderColor: 'transparent',
    colorEmbedded: '#121216',
    actionColor: '#121216',
  },
  Button: { borderRadiusMedium: '8px', borderRadiusSmall: '8px', fontWeight: '500' },
  Input: { borderRadius: '8px', color: '#171d25', colorFocus: '#1c232c' },
  DataTable: { borderRadius: '10px', thColor: '#0b0f15', tdColor: '#10151c' },
  Table: {
    borderRadius: '10px',
    thColor: '#0b0f15',
    tdColor: '#10151c',
    borderColor: 'rgba(145, 152, 161, 0.14)',
  },
  Tabs: {
    tabColorSegment: '#202028',
    colorSegment: '#121216',
    tabBorderRadius: '8px',
    tabTextColorLine: 'rgba(255, 255, 255, 0.72)',
    tabTextColorActiveLine: '#f2f4f8',
    tabTextColorHoverLine: '#f2f4f8',
    tabFontWeightActive: '600',
    paneTextColor: '#f2f4f8',
  },
  Alert: {
    borderRadius: '12px',
    borderError: '1px solid transparent',
    colorError: 'rgba(255, 255, 255, 0.08)',
    iconColorError: '#f2f4f8',
    titleTextColorError: '#f2f4f8',
    contentTextColorError: 'rgba(255, 255, 255, 0.8)',
  },
  Tag: {
    borderRadius: '999px',
    textColorSuccess: '#8ab4ff',
    textColorInfo: '#8ab4ff',
    colorSuccess: 'rgba(59, 130, 246, 0.2)',
    colorInfo: 'rgba(59, 130, 246, 0.2)',
    textColorWarning: 'rgba(255, 255, 255, 0.72)',
    colorWarning: 'rgba(255, 255, 255, 0.08)',
    textColorDefault: 'rgba(255, 255, 255, 0.72)',
    textColorError: '#f2f4f8',
    colorError: 'rgba(255, 255, 255, 0.1)',
  },
  Drawer: { headerBorderBottom: '0 solid transparent', footerBorderTop: '0 solid transparent', color: '#1a1a20' },
  Descriptions: { thColor: 'transparent', tdColor: '#1a1a20', borderColor: 'transparent' },
};

const App = defineComponent({
  name: 'App',
  setup() {
    const { isDark } = useTheme();
    const theme = computed(() => (isDark.value ? darkTheme : null));
    const overrides = computed(() => (isDark.value ? darkOverrides : lightOverrides));

    return () =>
      h(
        NConfigProvider,
        { theme: theme.value, themeOverrides: overrides.value, locale: zhCN, dateLocale: dateZhCN },
        {
          default: () =>
            h(NDialogProvider, null, {
              default: () =>
                h(NNotificationProvider, null, {
                  default: () => h(NMessageProvider, null, { default: () => h(RouterView) }),
                }),
            }),
        },
      );
  },
});

export default App;
</script>
