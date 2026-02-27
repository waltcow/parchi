import type { Message } from '../../../ai/message-schema.js';
import { SidePanelUI } from '../core/panel-ui.js';

/**
 * Show export menu with options.
 */
(SidePanelUI.prototype as any).showExportMenu = function showExportMenu(): void {
  // Remove any existing menu
  const existing = document.getElementById('exportMenu');
  if (existing) {
    existing.remove();
    return;
  }

  const menu = document.createElement('div');
  menu.id = 'exportMenu';
  menu.className = 'export-menu';

  menu.innerHTML = `
    <div class="export-menu-content">
      <div class="export-menu-header">
        <span>Export</span>
        <button class="export-menu-close" title="Close">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="export-menu-options">
        <button class="export-option" data-action="conversation">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          <span>
            <strong>Full Conversation</strong>
            <small>Export all messages as markdown</small>
          </span>
        </button>
        <button class="export-option" data-action="response">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
          <span>
            <strong>Last Response</strong>
            <small>Export just the last assistant message</small>
          </span>
        </button>
        <button class="export-option" data-action="turns">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line>
            <line x1="3" y1="12" x2="3.01" y2="12"></line>
            <line x1="3" y1="18" x2="3.01" y2="18"></line>
          </svg>
          <span>
            <strong>Detailed Turns</strong>
            <small>Export with tool events and plans</small>
          </span>
        </button>
      </div>
    </div>
  `;

  // Position menu near the export button
  const btn = this.elements.exportBtn;
  if (btn) {
    const rect = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;
  }

  // Add event listeners
  const closeBtn = menu.querySelector('.export-menu-close');
  closeBtn?.addEventListener('click', () => menu.remove());

  menu.querySelectorAll('.export-option').forEach((option) => {
    option.addEventListener('click', () => {
      const action = (option as HTMLElement).dataset.action;
      menu.remove();

      switch (action) {
        case 'conversation':
          this.exportConversationToMarkdown();
          break;
        case 'response':
          this.exportLastResponseToMarkdown();
          break;
        case 'turns':
          this.exportTurnsToMarkdown();
          break;
      }
    });
  });

  // Close on outside click
  const closeOnOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener('click', closeOnOutside);
    }
  };
  setTimeout(() => document.addEventListener('click', closeOnOutside), 0);

  document.body.appendChild(menu);
};

/**
 * Export the current conversation to a markdown file.
 * Handles both display history and tool events from turns.
 */
(SidePanelUI.prototype as any).exportConversationToMarkdown = function exportConversationToMarkdown(): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `conversation-${timestamp}.md`;

  let markdown = '';

  // Add header
  markdown += '# Conversation Export\n\n';
  markdown += `**Exported:** ${new Date().toLocaleString()}\n`;
  markdown += `**Session ID:** ${this.sessionId || 'unknown'}\n\n`;
  markdown += '---\n\n';

  // Export from display history (clean messages)
  if (this.displayHistory && this.displayHistory.length > 0) {
    for (const entry of this.displayHistory) {
      if (entry.role === 'user') {
        markdown += '## User\n\n';
        markdown += `${this.extractTextContent(entry.content)}\n\n`;
      } else if (entry.role === 'assistant') {
        markdown += '## Assistant\n\n';
        if (entry.thinking) {
          markdown += `<details>\n<summary>Thinking</summary>\n\n${entry.thinking}\n\n</details>\n\n`;
        }
        markdown += `${this.extractTextContent(entry.content)}\n\n`;
      } else if (entry.role === 'system' && entry.meta?.kind === 'summary') {
        markdown += `> **Context Summary:** ${this.extractTextContent(entry.content)}\n\n`;
      }
    }
  }

  // Export tool events from turns if available
  if (this.historyTurnMap && this.historyTurnMap.size > 0) {
    markdown += '---\n\n## Tool Events\n\n';

    this.historyTurnMap.forEach((turn: any, _turnId: string) => {
      if (turn.toolEvents && turn.toolEvents.length > 0) {
        markdown += `### Turn: ${turn.userMessage?.substring(0, 50) || 'Unknown'}...\n\n`;

        for (const event of turn.toolEvents) {
          if (event.type === 'tool_execution_start') {
            markdown += `**${event.tool}**`;
            if (event.args && Object.keys(event.args).length > 0) {
              markdown += ` \`${JSON.stringify(event.args).substring(0, 100)}\``;
            }
            markdown += '\n';
          } else if (event.type === 'tool_execution_result') {
            const resultPreview = event.result ? JSON.stringify(event.result).substring(0, 200) : 'no result';
            markdown += `  → ${resultPreview}${resultPreview.length >= 200 ? '...' : ''}\n\n`;
          }
        }
      }
    });
  }

  // Add subagent info if any
  if (this.subagents && this.subagents.size > 0) {
    markdown += '---\n\n## Subagents\n\n';
    this.subagents.forEach((agent: any, _id: string) => {
      markdown += `- **${agent.name}** (${agent.status})\n`;
      if (agent.tasks && agent.tasks.length > 0) {
        for (const task of agent.tasks) {
          markdown += `  - ${task}\n`;
        }
      }
      markdown += '\n';
    });
  }

  // Add plan if exists
  if (this.currentPlan && this.currentPlan.steps) {
    markdown += '---\n\n## Plan\n\n';
    for (let i = 0; i < this.currentPlan.steps.length; i++) {
      const step = this.currentPlan.steps[i];
      const checkbox = step.status === 'done' ? '[x]' : '[ ]';
      markdown += `${checkbox} ${step.title}\n`;
    }
    markdown += '\n';
  }

  // Add usage stats if available
  if (this.sessionTokenTotals && (this.sessionTokenTotals.inputTokens || this.sessionTokenTotals.outputTokens)) {
    markdown += '---\n\n## Usage Statistics\n\n';
    markdown += `- **Input tokens:** ${this.sessionTokenTotals.inputTokens.toLocaleString()}\n`;
    markdown += `- **Output tokens:** ${this.sessionTokenTotals.outputTokens.toLocaleString()}\n`;
    markdown += `- **Total tokens:** ${this.sessionTokenTotals.totalTokens.toLocaleString()}\n`;
  }

  markdown = this.appendSelectedReportImagesMarkdown(markdown);

  // Download the file
  this.downloadMarkdown(markdown, filename);
};

/**
 * Export just the last assistant response to markdown.
 */
(SidePanelUI.prototype as any).exportLastResponseToMarkdown = function exportLastResponseToMarkdown(): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `response-${timestamp}.md`;

  // Find the last assistant message
  let lastAssistant: Message | null = null;
  if (this.displayHistory && this.displayHistory.length > 0) {
    for (let i = this.displayHistory.length - 1; i >= 0; i--) {
      if (this.displayHistory[i].role === 'assistant') {
        lastAssistant = this.displayHistory[i];
        break;
      }
    }
  }

  if (!lastAssistant) {
    this.updateStatus('No assistant response to export', 'warning');
    return;
  }

  let markdown = '';

  if (lastAssistant.thinking) {
    markdown += `<details>\n<summary>Thinking</summary>\n\n${lastAssistant.thinking}\n\n</details>\n\n`;
  }

  markdown += `${this.extractTextContent(lastAssistant.content)}\n`;
  markdown = this.appendSelectedReportImagesMarkdown(markdown);

  this.downloadMarkdown(markdown, filename);
};

/**
 * Export selected/all turns from history.
 */
(SidePanelUI.prototype as any).exportTurnsToMarkdown = function exportTurnsToMarkdown(): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `turns-${timestamp}.md`;

  let markdown = '# Conversation Turns\n\n';
  markdown += `**Exported:** ${new Date().toLocaleString()}\n\n`;
  markdown += '---\n\n';

  if (!this.historyTurnMap || this.historyTurnMap.size === 0) {
    markdown += 'No turn data available.\n';
    this.downloadMarkdown(markdown, filename);
    return;
  }

  this.historyTurnMap.forEach((turn: any, turnId: string) => {
    markdown += `## Turn ${turnId}\n\n`;
    markdown += `**User:** ${turn.userMessage || 'N/A'}\n\n`;

    if (turn.plan && turn.plan.steps) {
      markdown += '### Plan\n\n';
      for (const step of turn.plan.steps) {
        const checkbox = step.status === 'done' ? '[x]' : '[ ]';
        markdown += `${checkbox} ${step.title}\n`;
      }
      markdown += '\n';
    }

    if (turn.toolEvents && turn.toolEvents.length > 0) {
      markdown += '### Tool Events\n\n';
      markdown += '| Tool | Args | Result |\n';
      markdown += '|------|------|--------|\n';
      for (const event of turn.toolEvents) {
        if (event.type === 'tool_execution_result') {
          const argsPreview = event.args ? JSON.stringify(event.args).substring(0, 50).replace(/\|/g, '\\|') : '';
          const resultPreview = event.result ? JSON.stringify(event.result).substring(0, 80).replace(/\|/g, '\\|') : '';
          markdown += `| ${event.tool} | ${argsPreview} | ${resultPreview} |\n`;
        }
      }
      markdown += '\n';
    }

    if (turn.assistantFinal) {
      markdown += '### Assistant Response\n\n';
      if (turn.assistantFinal.thinking) {
        markdown += `<details>\n<summary>Thinking</summary>\n\n${turn.assistantFinal.thinking}\n\n</details>\n\n`;
      }
      markdown += `${turn.assistantFinal.content || ''}\n\n`;
    }

    markdown += '---\n\n';
  });

  markdown = this.appendSelectedReportImagesMarkdown(markdown);
  this.downloadMarkdown(markdown, filename);
};

(SidePanelUI.prototype as any).getSelectedReportImagesForExport = function getSelectedReportImagesForExport() {
  if (!this.reportImages || this.reportImages.size === 0) return [];
  const order = Array.isArray(this.reportImageOrder) && this.reportImageOrder.length > 0
    ? this.reportImageOrder
    : Array.from(this.reportImages.keys());
  const selected = this.selectedReportImageIds instanceof Set ? this.selectedReportImageIds : new Set<string>();

  return order
    .map((id: string) => this.reportImages.get(id))
    .filter((image: any) => image && typeof image.dataUrl === 'string' && selected.has(image.id));
};

(SidePanelUI.prototype as any).appendSelectedReportImagesMarkdown = function appendSelectedReportImagesMarkdown(
  markdown: string,
) {
  const images = this.getSelectedReportImagesForExport();
  if (!images.length) return markdown;

  let next = markdown;
  next += '\n---\n\n## Selected Report Images\n\n';
  images.forEach((image: any, index: number) => {
    const label = image.title || image.url || image.id;
    next += `### Image ${index + 1}: ${label}\n\n`;
    next += `- **ID:** ${image.id}\n`;
    next += `- **Captured:** ${new Date(Number(image.capturedAt || Date.now())).toLocaleString()}\n`;
    if (image.url) next += `- **Source URL:** ${image.url}\n`;
    if (image.visionDescription) next += `- **Vision Notes:** ${image.visionDescription}\n`;
    next += '\n';
    next += `![Report image ${index + 1}](${image.dataUrl})\n\n`;
  });
  return next;
};

/**
 * Helper to extract text content from various content formats.
 */
(SidePanelUI.prototype as any).extractTextContent = function extractTextContent(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (part.type === 'text' && part.text) return part.text;
          if (part.type === 'tool-result') {
            const output = part.output;
            if (output && typeof output === 'object') {
              if (output.type === 'text' && output.value) return output.value;
              if (output.type === 'json') return JSON.stringify(output.value, null, 2);
              return JSON.stringify(output, null, 2);
            }
            return String(output || '');
          }
          return part.text || part.content || '';
        }
        return '';
      })
      .join('\n');
  }
  return String(content);
};

/**
 * Download markdown content as a file.
 */
(SidePanelUI.prototype as any).downloadMarkdown = function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';

  document.body.appendChild(link);
  link.click();

  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);

  this.updateStatus(`已导出到 ${filename}`, 'success');
};
