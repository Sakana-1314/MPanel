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
    bodyColor: '#f6f8fa',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    tableColor: '#ffffff',
    inputColor: '#ffffff',
    borderColor: '#d1d9e0',
    dividerColor: '#d8dee4',
    textColorBase: '#1f2328',
    textColor1: '#1f2328',
    textColor2: '#1f2328',
    textColor3: '#59636e',
    hoverColor: 'rgba(31, 35, 40, 0.04)',
  },
  Layout: { siderColor: '#f6f8fa', headerColor: '#ffffff', color: '#f6f8fa' },
  Card: { borderRadius: '6px', paddingSmall: '14px 16px' },
  Button: { borderRadiusMedium: '6px', borderRadiusSmall: '6px', fontWeight: '500' },
  Input: { borderRadius: '6px' },
  DataTable: { borderRadius: '6px' },
  Tag: { borderRadius: '999px' },
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
    cardColor: '#0d1117',
    modalColor: '#0d1117',
    popoverColor: '#151b23',
    tableColor: '#0d1117',
    inputColor: '#0d1117',
    borderColor: '#3d444d',
    dividerColor: '#30363d',
    textColorBase: '#e6edf3',
    textColor1: '#e6edf3',
    textColor2: '#e6edf3',
    textColor3: '#9198a1',
    hoverColor: 'rgba(177, 186, 196, 0.12)',
  },
  Layout: { siderColor: '#010409', headerColor: '#0d1117', color: '#010409' },
  Card: { borderRadius: '6px', paddingSmall: '14px 16px' },
  Button: { borderRadiusMedium: '6px', borderRadiusSmall: '6px', fontWeight: '500' },
  Input: { borderRadius: '6px' },
  DataTable: { borderRadius: '6px' },
  Tag: { borderRadius: '999px' },
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
