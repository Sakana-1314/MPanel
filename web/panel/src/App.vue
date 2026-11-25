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

const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#4f7cff',
    primaryColorHover: '#6f94ff',
    primaryColorPressed: '#3b66e0',
    primaryColorSuppl: '#4f7cff',
    infoColor: '#4f7cff',
    successColor: '#2fbf71',
    warningColor: '#e6a23c',
    errorColor: '#e05561',
    borderRadius: '8px',
    fontFamily:
      'Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, -apple-system, sans-serif',
    fontFamilyMono:
      '"JetBrains Mono", "Cascadia Code", Consolas, "SFMono-Regular", ui-monospace, monospace',
  },
  Layout: {
    siderColor: 'transparent',
    headerColor: 'transparent',
    color: 'transparent',
  },
  Card: {
    borderRadius: '12px',
  },
  DataTable: {
    borderRadius: '10px',
  },
};

const App = defineComponent({
  name: 'App',
  setup() {
    const { isDark } = useTheme();
    const theme = computed(() => (isDark.value ? darkTheme : null));

    return () =>
      h(NConfigProvider, { theme: theme.value, themeOverrides, locale: zhCN, dateLocale: dateZhCN }, {
        default: () =>
          h(NDialogProvider, null, {
            default: () =>
              h(NNotificationProvider, null, {
                default: () => h(NMessageProvider, null, { default: () => h(RouterView) }),
              }),
          }),
      });
  },
});

export default App;
</script>
