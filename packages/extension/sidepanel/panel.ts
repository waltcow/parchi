import './ui/panel-modules.js';
import { loadPanelLayout } from './ui/core/layout-loader.js';
import { SidePanelUI } from './ui/core/panel-ui.js';

declare const __PERF_DEBUG__: boolean;

const init = async () => {
  await loadPanelLayout();
  const ui = new SidePanelUI();
  // Expose for debugging
  (window as any).sidePanelUI = ui;

  // Performance monitor — only loaded when PERF_DEBUG=true build or runtime toggle
  if (__PERF_DEBUG__ || (window as any).__PERF_DEBUG__) {
    const { perfMonitor } = await import('../utils/perf-monitor.js');
    perfMonitor.start();
  }
};

void init();
