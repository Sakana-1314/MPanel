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
    primaryColor: '#0969da',
    primaryColorHover: '#0860c3',
    primaryColorPressed: '#0550a5',
    primaryColorSuppl: '#0969da',
    infoColor: '#0969da',
    successColor: '#1a7f37',
    warningColor: '#9a6700',
    errorColor: '#cf222e',
    bodyColor: '#eef1f5',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    tableColor: '#ffffff',
    inputColor: '#f5f7fa',
    actionColor: '#f5f7fa',
    tableHeaderColor: '#eef1f5',
    tableColorStriped: 'rgba(31, 35, 40, 0.02)',
    borderColor: '#d1d9e0',
    dividerColor: '#dde3ea',
    textColorBase: '#1f2328',
    textColor1: '#1f2328',
    textColor2: '#1f2328',
    textColor3: '#59636e',
    hoverColor: 'rgba(31, 35, 40, 0.05)',
    boxShadow1: '0 1px 2px rgba(31, 35, 40, 0.06), 0 4px 12px rgba(31, 35, 40, 0.06)',
    boxShadow2: '0 6px 20px rgba(31, 35, 40, 0.1)',
    boxShadow3: '0 10px 34px rgba(31, 35, 40, 0.14)',
  },
  Layout: { siderColor: '#eef1f5', headerColor: '#eef1f5', color: '#eef1f5' },
  Card: {
    borderRadius: '10px',
    paddingSmall: '14px 16px',
    color: '#ffffff',
    borderColor: 'transparent',
    colorEmbedded: '#f5f7fa',
    actionColor: '#f5f7fa',
  },
  Button: { borderRadiusMedium: '6px', borderRadiusSmall: '6px', fontWeight: '500' },
  Input: { borderRadius: '8px', color: '#f5f7fa', colorFocus: '#ffffff' },
  DataTable: { borderRadius: '10px', thColor: '#eef1f5', tdColor: '#ffffff' },
  Table: {
    borderRadius: '10px',
    thColor: '#eef1f5',
    tdColor: '#ffffff',
    borderColor: 'rgba(89, 99, 110, 0.14)',
  },
  Tabs: {
    tabColorSegment: '#ffffff',
    colorSegment: '#e9edf2',
    tabBorderRadius: '8px',
    tabTextColorLine: '#59636e',
    tabTextColorActiveLine: '#1f2328',
    tabTextColorHoverLine: '#1f2328',
    tabFontWeightActive: '600',
    paneTextColor: '#1f2328',
  },
  Alert: { borderRadius: '10px' },
  Tag: { borderRadius: '999px' },
  Drawer: { headerBorderBottom: '0 solid transparent', footerBorderTop: '0 solid transparent', color: '#ffffff' },
  Descriptions: { thColor: '#f5f7fa', tdColor: '#ffffff', borderColor: 'transparent' },
};

const darkOverrides: GlobalThemeOverrides = {
  common: {
    ...baseCommon,
    primaryColor: '#4493f8',
    primaryColorHover: '#58a6ff',
    primaryColorPressed: '#388bfd',
    primaryColorSuppl: '#4493f8',
    infoColor: '#4493f8',
    successColor: '#3fb950',
    warningColor: '#d29922',
    errorColor: '#f85149',
    bodyColor: '#010409',
    cardColor: '#10151c',
    modalColor: '#10151c',
    popoverColor: '#191f28',
    tableColor: '#10151c',
    inputColor: '#171d25',
    actionColor: '#171d25',
    tableHeaderColor: '#0b0f15',
    tableColorStriped: 'rgba(255, 255, 255, 0.02)',
    borderColor: '#29313a',
    dividerColor: '#222a33',
    textColorBase: '#e6edf3',
    textColor1: '#e6edf3',
    textColor2: '#e6edf3',
    textColor3: '#9198a1',
    hoverColor: 'rgba(177, 186, 196, 0.1)',
    boxShadow1: '0 1px 2px rgba(0, 0, 0, 0.4), 0 6px 18px rgba(0, 0, 0, 0.45)',
    boxShadow2: '0 8px 24px rgba(0, 0, 0, 0.55)',
    boxShadow3: '0 14px 40px rgba(0, 0, 0, 0.6)',
  },
  Layout: { siderColor: '#010409', headerColor: '#010409', color: '#010409' },
  Card: {
    borderRadius: '10px',
    paddingSmall: '14px 16px',
    color: '#10151c',
    borderColor: 'transparent',
    colorEmbedded: '#171d25',
    actionColor: '#171d25',
  },
  Button: { borderRadiusMedium: '6px', borderRadiusSmall: '6px', fontWeight: '500' },
  Input: { borderRadius: '8px', color: '#171d25', colorFocus: '#1c232c' },
  DataTable: { borderRadius: '10px', thColor: '#0b0f15', tdColor: '#10151c' },
  Table: {
    borderRadius: '10px',
    thColor: '#0b0f15',
    tdColor: '#10151c',
    borderColor: 'rgba(145, 152, 161, 0.14)',
  },
  Tabs: {
    tabColorSegment: '#1c232c',
    colorSegment: '#0b0f15',
    tabBorderRadius: '8px',
    tabTextColorLine: '#9198a1',
    tabTextColorActiveLine: '#e6edf3',
    tabTextColorHoverLine: '#e6edf3',
    tabFontWeightActive: '600',
    paneTextColor: '#e6edf3',
  },
  Alert: { borderRadius: '10px' },
  Tag: { borderRadius: '999px' },
  Drawer: { headerBorderBottom: '0 solid transparent', footerBorderTop: '0 solid transparent', color: '#10151c' },
  Descriptions: { thColor: '#171d25', tdColor: '#10151c', borderColor: 'transparent' },
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
