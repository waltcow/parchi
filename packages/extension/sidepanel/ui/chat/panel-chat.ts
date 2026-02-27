import { createMessage } from '../../../ai/message-schema.js';
import type { Message } from '../../../ai/message-schema.js';
import { dedupeThinking, extractThinking } from '../../../ai/message-utils.js';
import { getActiveTab } from '../../../utils/active-tab.js';
import { SidePanelUI } from '../core/panel-ui.js';
import type { UsagePayload } from '../types/panel-types.js';

const MAX_DISPLAY_HISTORY = 400;

const truncate = (value: string, max = 12000) => {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
};

// Chrome runtime messaging can fail on large payloads or non-cloneable values.
// Keep history compact and remove heavy fields (e.g. screenshots/dataUrls) before sending to background.
const sanitizeForMessaging = (value: any, depth = 0): any => {
  if (value == null) return value;
  if (typeof value === 'string') {
    const s = value;
    if (s.startsWith('data:image/') || s.startsWith('data:application/octet-stream')) {
      return '[omitted dataUrl]';
    }
    return truncate(s, 12000);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function') return undefined;
  if (depth > 6) return '[truncated]';

  if (Array.isArray(value)) {
    const out: any[] = [];
    const limit = Math.min(value.length, 80);
    for (let i = 0; i < limit; i += 1) {
      out.push(sanitizeForMessaging(value[i], depth + 1));
    }
    if (value.length > limit) out.push(`[+${value.length - limit} items truncated]`);
    return out;
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: truncate(value.stack || '', 2000) };
  }

  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'dataUrl') {
        out[k] = '[omitted dataUrl]';
        continue;
      }
      out[k] = sanitizeForMessaging(v, depth + 1);
    }
    return out;
  }

  return String(value);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isMissingReceiverError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Receiving end does not exist|Could not establish connection/i.test(message);
};

const sendRuntimeMessageWithRetry = async (payload: Record<string, unknown>, retries = 1) => {
  let attempt = 0;
  while (true) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (error) {
      if (attempt >= retries || !isMissingReceiverError(error)) {
        throw error;
      }
      attempt += 1;
      await sleep(250);
    }
  }
};

(SidePanelUI.prototype as any).sendMessage = async function sendMessage() {
  const userMessage = this.elements.userInput.value.trim();
  if (!userMessage) return;

  this.pendingTurnDraft = { userMessage, startedAt: Date.now() };

  this.elements.userInput.value = '';
  this.elements.userInput.style.height = '';
  if (!this.firstUserMessage) {
    this.firstUserMessage = userMessage;
  }

  this.pendingToolCount = 0;
  this.isStreaming = false;
  this.streamingState = null;
  this.stepTimeline.steps.clear();
  this.stepTimeline.activeStepIndex = null;
  this.stepTimeline.activeStepBody = null;
  this.activeToolName = null;
  this.latestThinking = null;
  this.clearRunIncompleteBanner();
  this.updateActivityState();

  let selectedTabsPayload = Array.from(this.selectedTabs.values());
  let tabsContext = this.getSelectedTabsContext(selectedTabsPayload);

  if (selectedTabsPayload.length === 0) {
    try {
      const activeTab = await getActiveTab();
      if (activeTab && typeof activeTab.id === 'number') {
        const autoTab = this.buildSelectedTab(activeTab);
        selectedTabsPayload = [autoTab];
        tabsContext = this.getSelectedTabsContext(selectedTabsPayload, 'active');
      }
    } catch (error) {
      console.warn('Failed to capture active tab context:', error);
    }
  }

  const fullMessage = userMessage + tabsContext;

  this.displayUserMessage(userMessage);

  const displayEntry = createMessage({ role: 'user', content: userMessage });
  if (displayEntry) {
    this.displayHistory.push(displayEntry);
    if (this.displayHistory.length > MAX_DISPLAY_HISTORY) {
      this.displayHistory.splice(0, this.displayHistory.length - MAX_DISPLAY_HISTORY);
    }
  }

  const contextEntry = createMessage({ role: 'user', content: fullMessage });
  if (contextEntry) {
    this.contextHistory.push(contextEntry);
  }
  this.updateContextUsage();

  this.updateStatus('Processing...', 'active');
  this.elements.composer?.classList.add('running');
  this.startRunTimer?.();
  this.startWatchdog?.();

  try {
    // Avoid sending huge tool payloads; also ensures errors are caught (promise-based APIs).
    const sendableHistory = sanitizeForMessaging(this.contextHistory || []);
    const payload: Record<string, unknown> = {
      type: 'user_message',
      message: fullMessage,
      conversationHistory: sendableHistory,
      selectedTabs: selectedTabsPayload,
      sessionId: this.sessionId,
    };
    if (this.pendingRecordedContext) {
      payload.recordedContext = this.pendingRecordedContext;
      this.pendingRecordedContext = null;
      this.hideRecordedContextBadge?.();
    }
    const response = await sendRuntimeMessageWithRetry(payload);
    if (response?.sessionId && typeof response.sessionId === 'string') {
      this.sessionId = response.sessionId;
    }
    // Note: persistHistory is called after the assistant response completes
    // in displayAssistantMessage to ensure complete conversation is saved
  } catch (error: any) {
    this.stopThinkingTimer?.();
    this.stopRunTimer?.();
    this.stopWatchdog?.();
    this.pendingTurnDraft = null;
    this.pendingRecordedContext = null;
    this.hideRecordedContextBadge?.();
    this.updateStatus('Error: ' + error.message, 'error');
    this.elements.composer?.classList.remove('running');
    this.displayAssistantMessage('抱歉，发生错误：' + error.message);
  }
};

(SidePanelUI.prototype as any).displayUserMessage = function displayUserMessage(content: string) {
  const turn = document.createElement('div');
  turn.className = 'chat-turn';
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message user';
  messageDiv.innerHTML = `
      <div class="message-header">你</div>
      <div class="message-content">${this.escapeHtml(content)}</div>
    `;
  turn.appendChild(messageDiv);
  this.elements.chatMessages.appendChild(turn);
  this.lastChatTurn = turn;
  this.scrollToBottom({ force: true });
  this.updateChatEmptyState();
};

(SidePanelUI.prototype as any).displaySummaryMessage = function displaySummaryMessage(
  messageOrEntry: Message | string,
) {
  const content = typeof messageOrEntry === 'string' ? messageOrEntry : String(messageOrEntry.content || '');
  const container = document.createElement('div');
  container.className = 'message summary';
  container.innerHTML = `
      <div class="summary-header">上下文已压缩</div>
      <div class="summary-body">${this.renderMarkdown(content)}</div>
    `;
  this.elements.chatMessages.appendChild(container);
  this.scrollToBottom();
  this.updateChatEmptyState();
};

(SidePanelUI.prototype as any).updateChatEmptyState = function updateChatEmptyState() {
  const emptyState = this.elements.chatEmptyState;
  if (!emptyState) return;
  const hasMessages =
    (this.displayHistory && this.displayHistory.length > 0) ||
    (this.elements.chatMessages && this.elements.chatMessages.children.length > 0);
  emptyState.classList.toggle('hidden', hasMessages);
};

(SidePanelUI.prototype as any).displayAssistantMessage = function displayAssistantMessage(
  content: string,
  thinking: string | null = null,
  usage: UsagePayload | null = null,
  model: string | null = null,
) {
  this.stopThinkingTimer?.();
  const streamResult = this.finishStreamingMessage();
  const streamedContainer = streamResult?.container;
  const streamEventsEl = streamedContainer?.querySelector('.stream-events') as HTMLElement | null;
  const hasStreamEvents = Boolean(streamEventsEl && streamEventsEl.children.length > 0);
  let normalizedUsage = this.normalizeUsage(usage);
  const modelLabel = model || this.getActiveModelLabel();
  const combinedThinking = [streamResult?.thinking, thinking].filter(Boolean).join('\n\n') || null;
  const showThinking = this.elements.showThinking?.value === 'true';

  if ((!content || content.trim() === '') && !combinedThinking && !hasStreamEvents) {
    if (streamedContainer) {
      streamedContainer.remove();
    }
    this.updateStatus('Ready', 'success');
    this.elements.composer?.classList.remove('running');
    this.stopWatchdog?.();
    this.pendingToolCount = 0;
    this.updateActivityState();
    return;
  }

  const parsed = extractThinking(content, combinedThinking);
  content = parsed.content;
  thinking = parsed.thinking;
  if (thinking) {
    // (debug log removed)
  } else {
    // (debug log removed)
  }
  this.updateThinkingPanel(thinking, false);

  if (!normalizedUsage) {
    normalizedUsage = this.estimateUsageFromContent(content);
  }
  if (normalizedUsage) {
    this.updateUsageStats(normalizedUsage);
  }
  const messageMeta = this.buildMessageMeta(normalizedUsage, modelLabel);
  const selectedReportImages = typeof this.getSelectedReportImagesForExport === 'function'
    ? this.getSelectedReportImagesForExport()
    : [];
  const buildReportImagesHtml = () => {
    if (!Array.isArray(selectedReportImages) || selectedReportImages.length === 0) return '';
    const cards = selectedReportImages
      .map((image: any, index: number) => {
        const label = this.escapeHtml(image.title || image.url || image.id || `Image ${index + 1}`);
        const src = String(image.dataUrl || '');
        if (!src) return '';
        return `
          <figure class="report-image-card">
            <img src="${src}" alt="${label}" loading="lazy" />
            <figcaption>${label}</figcaption>
          </figure>
        `;
      })
      .join('');
    if (!cards) return '';
    return `
      <div class="report-images-inline">
        <div class="report-images-inline-title">Selected report images</div>
        <div class="report-images-inline-grid">${cards}</div>
      </div>
    `;
  };

  const assistantEntry = createMessage({
    role: 'assistant',
    content,
    thinking,
  });
  if (assistantEntry) {
    this.displayHistory.push(assistantEntry);
    if (this.displayHistory.length > MAX_DISPLAY_HISTORY) {
      this.displayHistory.splice(0, this.displayHistory.length - MAX_DISPLAY_HISTORY);
    }
  }

  if (streamedContainer) {
    if (!streamedContainer.querySelector('.message-header')) {
      const header = document.createElement('div');
      header.className = 'message-header';
      header.textContent = 'Assistant';
      streamedContainer.prepend(header);
    }

    if (messageMeta) {
      let metaEl = streamedContainer.querySelector('.message-meta') as HTMLElement | null;
      if (!metaEl) {
        metaEl = document.createElement('div');
        metaEl.className = 'message-meta';
        const header = streamedContainer.querySelector('.message-header');
        if (header) {
          header.insertAdjacentElement('afterend', metaEl);
        } else {
          streamedContainer.prepend(metaEl);
        }
      }
      metaEl.textContent = messageMeta;
    }

    if (thinking && showThinking && streamEventsEl) {
      const existingThinking = streamedContainer.querySelector(
        '.thinking-block, .inline-thinking-block, .stream-event-reasoning',
      );
      const cleanedThinking = dedupeThinking(thinking);
      if (!existingThinking && cleanedThinking) {
        const thinkingBlock = document.createElement('div');
        thinkingBlock.className = 'thinking-block collapsed';
        thinkingBlock.innerHTML = `
            <button class="thinking-header" type="button" aria-expanded="false">
              <svg class="chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
              Thought process
            </button>
            <div class="thinking-content">${this.escapeHtml(cleanedThinking)}</div>
          `;

        const targetBody = streamedContainer.querySelector('.step-body') as HTMLElement | null;
        const target = targetBody || streamEventsEl;
        const firstChild = target.firstChild;
        if (firstChild) {
          target.insertBefore(thinkingBlock, firstChild);
        } else {
          target.appendChild(thinkingBlock);
        }

        const thinkingHeader = thinkingBlock.querySelector('.thinking-header');
        if (thinkingHeader) {
          thinkingHeader.addEventListener('click', () => {
            const block = thinkingHeader.closest('.thinking-block');
            if (!block || block.classList.contains('thinking-hidden')) return;
            block.classList.toggle('collapsed');
            const expanded = !block.classList.contains('collapsed');
            thinkingHeader.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          });
        }
      }
    }

    // Clean up ALL streamed text blocks (they may contain raw <think> tags)
    if (streamEventsEl) {
      const textEvents = streamedContainer.querySelectorAll('.stream-event-text');
      Array.from(textEvents).forEach((el) => (el as Element).remove());
      // Add a single clean text block with the final content
      if (content && content.trim() !== '') {
        const textEvent = document.createElement('div');
        textEvent.className = 'stream-event stream-event-text';
        textEvent.innerHTML = this.renderMarkdown(content);
        streamEventsEl.appendChild(textEvent);
      }

      const reportImagesHtml = buildReportImagesHtml();
      if (reportImagesHtml) {
        const existing = streamEventsEl.querySelector('.report-images-inline');
        existing?.remove();
        const reportBlock = document.createElement('div');
        reportBlock.className = 'stream-event stream-event-report-images';
        reportBlock.innerHTML = reportImagesHtml;
        streamEventsEl.appendChild(reportBlock);
      }

      // Collapse tool rows by default with a summary toggle
      const toolRows = streamEventsEl.querySelectorAll('.tool-row');
      if (toolRows.length > 0) {
        const errorCount = streamEventsEl.querySelectorAll('.tool-row.error').length;
        const label = `${toolRows.length} tool call${toolRows.length !== 1 ? 's' : ''}${errorCount > 0 ? ` · ${errorCount} error${errorCount !== 1 ? 's' : ''}` : ''}`;
        const toggle = document.createElement('button');
        toggle.className = 'tool-group-toggle';
        toggle.type = 'button';
        toggle.innerHTML = `
          <svg class="tool-group-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
          <span>${label}</span>
        `;
        toggle.addEventListener('click', () => {
          streamEventsEl.classList.toggle('tools-collapsed');
        });
        // Insert before the first tool row
        toolRows[0].insertAdjacentElement('beforebegin', toggle);
        streamEventsEl.classList.add('tools-collapsed');
      }
    }

    this.scrollToBottom();
    this.updateStatus('Ready', 'success');
    this.elements.composer?.classList.remove('running');
    this.stopWatchdog?.();
    this.stopRunTimer?.();
    this.pendingToolCount = 0;
    this.updateActivityState();
    this.nullifyFinalizedToolData();
    this.pruneOldChatTurns();
    this.persistHistory();
    this.updateChatEmptyState();
    return;
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant';

  let html = `<div class="message-header">Assistant</div>`;
  if (messageMeta) {
    html += `<div class="message-meta">${this.escapeHtml(messageMeta)}</div>`;
  }

  if (thinking && showThinking) {
    const cleanedThinking = dedupeThinking(thinking);
    html += `
        <div class="thinking-block collapsed">
          <button class="thinking-header" type="button" aria-expanded="false">
            <svg class="chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            Thought process
          </button>
          <div class="thinking-content">${this.escapeHtml(cleanedThinking)}</div>
        </div>
      `;
  }

  if (content && content.trim() !== '') {
    const renderedContent = this.renderMarkdown(content);
    html += `<div class="message-content markdown-body">${renderedContent}</div>`;
  }

  const reportImagesHtml = buildReportImagesHtml();
  if (reportImagesHtml) {
    html += reportImagesHtml;
  }

  messageDiv.innerHTML = html;

  const thinkingHeader = messageDiv.querySelector('.thinking-header');
  if (thinkingHeader) {
    thinkingHeader.addEventListener('click', () => {
      const block = thinkingHeader.closest('.thinking-block');
      if (!block || block.classList.contains('thinking-hidden')) return;
      block.classList.toggle('collapsed');
      const expanded = !block.classList.contains('collapsed');
      thinkingHeader.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  }

  if (this.lastChatTurn) {
    this.lastChatTurn.appendChild(messageDiv);
  } else {
    this.elements.chatMessages.appendChild(messageDiv);
  }
  this.scrollToBottom();
  this.updateStatus('Ready', 'success');
  this.elements.composer?.classList.remove('running');
  this.stopWatchdog?.();
  this.stopRunTimer?.();
  this.pendingToolCount = 0;
  this.updateActivityState();
  this.nullifyFinalizedToolData();
  this.pruneOldChatTurns();
  this.persistHistory();
  this.updateChatEmptyState();
};

const MAX_CHAT_TURNS = 100;
const PRUNE_PLACEHOLDER_CLASS = 'chat-pruned-placeholder';

(SidePanelUI.prototype as any).pruneOldChatTurns = function pruneOldChatTurns() {
  const container = this.elements.chatMessages;
  if (!container) return;

  const turns = Array.from(container.querySelectorAll('.chat-turn'));
  const excess = turns.length - MAX_CHAT_TURNS;
  if (excess <= 0) return;

  // Preserve scroll position relative to bottom
  const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;

  let removed = 0;
  for (let i = 0; i < turns.length && removed < excess; i++) {
    const turn = turns[i] as HTMLElement;
    // Never remove a turn that's still streaming
    if (turn.querySelector('.streaming')) continue;
    turn.remove();
    removed++;
  }

  if (removed > 0) {
    // Insert or update placeholder at top
    let placeholder = container.querySelector(`.${PRUNE_PLACEHOLDER_CLASS}`) as HTMLElement | null;
    if (!placeholder) {
      placeholder = document.createElement('div');
      placeholder.className = PRUNE_PLACEHOLDER_CLASS;
      container.prepend(placeholder);
    }
    const totalPruned = Number(placeholder.dataset.count || 0) + removed;
    placeholder.dataset.count = String(totalPruned);
    placeholder.textContent = `${totalPruned} earlier messages hidden`;

    // Restore scroll position relative to bottom to prevent visual jump
    container.scrollTop = container.scrollHeight - container.clientHeight - scrollBottom;
  }
};
