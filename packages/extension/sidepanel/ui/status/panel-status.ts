import { SidePanelUI } from '../core/panel-ui.js';

const MODEL_CATALOG_TTL_MS = 3 * 60 * 1000;
const MODEL_FETCH_TIMEOUT_MS = 9000;
const MAX_MODELS_PER_PROVIDER = 250;
const MAX_MODELS_TOTAL = 600;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

type ModelCatalogTarget = {
  key: string;
  provider: string;
  endpointBase: string;
  headers: Record<string, string>;
};

const normalizeProvider = (provider: unknown) => String(provider || '').trim().toLowerCase();

const normalizeHeaders = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key.length > 0)
      .map(([key, headerValue]) => [key, headerValue == null ? '' : String(headerValue)]),
  );
};

const normalizeEndpointBase = (provider: string, customEndpoint: string) => {
  const raw = String(customEndpoint || '').trim();
  const fallback =
    provider === 'openrouter' || provider === 'parchi'
      ? OPENROUTER_BASE_URL
      : provider === 'openai'
        ? 'https://api.openai.com/v1'
        : provider === 'anthropic'
          ? 'https://api.anthropic.com/v1'
          : provider === 'kimi'
            ? 'https://api.kimi.com/coding/v1'
            : '';

  const base = (raw || fallback)
    .replace(/\/chat\/completions\/?$/i, '')
    .replace(/\/completions\/?$/i, '')
    .replace(/\/v1\/messages\/?$/i, '')
    .replace(/\/messages\/?$/i, '')
    .replace(/\/+$/, '');
  return base;
};

const buildModelEndpointCandidates = (base: string): string[] => {
  const normalized = String(base || '').trim().replace(/\/+$/, '');
  if (!normalized) return [];
  if (/\/v1$/i.test(normalized) || /\/api\/v1$/i.test(normalized)) {
    return [`${normalized}/models`];
  }
  return [`${normalized}/models`, `${normalized}/v1/models`];
};

const extractModelIds = (payload: any): string[] => {
  if (!payload) return [];
  const source = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  const ids = source
    .map((entry: any) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry.id === 'string') return entry.id;
      if (entry && typeof entry.name === 'string') return entry.name;
      return '';
    })
    .map((id: string) => id.trim())
    .filter((id: string) => id.length > 0);

  return Array.from(new Set(ids));
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timerId: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timerId = window.setTimeout(() => reject(new Error('Timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timerId !== null) {
      window.clearTimeout(timerId);
    }
  }
};

(SidePanelUI.prototype as any).updateStatus = function updateStatus(text: string, type = 'default') {
  if (this.elements.statusText) {
    this.elements.statusText.textContent = text;
  }
  const statusDot = document.getElementById('statusDot');
  if (statusDot) {
    statusDot.className = 'status-dot';
    if (type === 'error') statusDot.classList.add('error');
    else if (type === 'warning') statusDot.classList.add('warning');
    else if (type === 'active') statusDot.classList.add('active');
  }
  this.updateActivityState();
};

(SidePanelUI.prototype as any).startRunTimer = function startRunTimer() {
  if (this.runTimerId) {
    window.clearInterval(this.runTimerId);
  }
  this.runStartedAt = Date.now();
  const tick = () => {
    this.updateActivityState?.();
  };
  tick();
  this.runTimerId = window.setInterval(tick, 1000);
};

(SidePanelUI.prototype as any).stopRunTimer = function stopRunTimer() {
  if (this.runTimerId) {
    window.clearInterval(this.runTimerId);
    this.runTimerId = null;
  }
  this.runStartedAt = null;
  this.updateActivityState?.();
};

(SidePanelUI.prototype as any).updateModelDisplay = function updateModelDisplay() {
  // Now the model select shows profiles, so we update it to the current config
  if (this.elements.modelSelect) {
    this.elements.modelSelect.value = this.currentConfig;
  }
};

(SidePanelUI.prototype as any).fetchAvailableModels = async function fetchAvailableModels() {
  this.populateModelSelect();
  this.updateModelDisplay();
  await this.refreshModelCatalog();
};

(SidePanelUI.prototype as any).collectConfiguredModelFallbacks = function collectConfiguredModelFallbacks() {
  const fallbacks: Array<{ provider: string; model: string }> = [];
  const configs = this.configs && typeof this.configs === 'object' ? this.configs : {};
  for (const profile of Object.values(configs)) {
    if (!profile || typeof profile !== 'object') continue;
    const provider = normalizeProvider((profile as any).provider);
    const model = String((profile as any).model || '').trim();
    if (!provider || !model) continue;
    fallbacks.push({ provider, model });
  }
  return fallbacks;
};

(SidePanelUI.prototype as any).collectModelCatalogTargets = async function collectModelCatalogTargets() {
  const targets: ModelCatalogTarget[] = [];
  const seen = new Set<string>();
  const configs = this.configs && typeof this.configs === 'object' ? this.configs : {};

  for (const profile of Object.values(configs)) {
    if (!profile || typeof profile !== 'object') continue;
    const provider = normalizeProvider((profile as any).provider);
    if (!provider) continue;

    const apiKey = String((profile as any).apiKey || '').trim();
    const extraHeaders = normalizeHeaders((profile as any).extraHeaders);
    const endpointBase = normalizeEndpointBase(provider, String((profile as any).customEndpoint || ''));
    if (!endpointBase) continue;

    const allowsUnauthedList = provider === 'openrouter' || provider === 'parchi';
    if (!apiKey && !allowsUnauthedList) continue;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...extraHeaders,
    };

    if (provider === 'anthropic' || provider === 'kimi') {
      if (apiKey) {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      }
    } else if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    if (provider === 'openrouter' || provider === 'parchi') {
      headers['HTTP-Referer'] = headers['HTTP-Referer'] || 'https://parchi.ai';
      headers['X-Title'] = headers['X-Title'] || 'Parchi';
    }

    const key = `${provider}|${endpointBase}|${Boolean(apiKey)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      key,
      provider,
      endpointBase,
      headers,
    });
  }

  return targets;
};

(SidePanelUI.prototype as any).fetchModelIdsForTarget = async function fetchModelIdsForTarget(
  target: ModelCatalogTarget,
) {
  const urls = buildModelEndpointCandidates(target.endpointBase);
  for (const url of urls) {
    try {
      const response = await withTimeout(
        fetch(url, {
          method: 'GET',
          headers: target.headers,
        }),
        MODEL_FETCH_TIMEOUT_MS,
      );
      if (!response.ok) continue;
      const payload = await response.json().catch(() => null);
      const modelIds = extractModelIds(payload).slice(0, MAX_MODELS_PER_PROVIDER);
      if (modelIds.length > 0) {
        return modelIds;
      }
    } catch {}
  }
  return [];
};

(SidePanelUI.prototype as any).applyModelSuggestions = function applyModelSuggestions() {
  const datalist = document.getElementById('modelSuggestions') as HTMLDataListElement | null;
  if (!datalist) return;

  const entries = Array.isArray(this.modelCatalogEntries) ? this.modelCatalogEntries : [];
  const deduped = new Map<string, string>();
  for (const entry of entries) {
    const model = String(entry?.model || '').trim();
    const provider = normalizeProvider(entry?.provider);
    if (!model || !provider) continue;
    if (!deduped.has(model)) {
      deduped.set(model, provider);
    }
  }

  const ordered = Array.from(deduped.entries())
    .map(([model, provider]) => ({ model, provider }))
    .sort((a, b) => a.model.localeCompare(b.model));

  datalist.innerHTML = '';
  for (const item of ordered.slice(0, MAX_MODELS_TOTAL)) {
    const option = document.createElement('option');
    option.value = item.model;
    option.label = item.provider;
    datalist.appendChild(option);
  }

  if (this.elements.model) this.elements.model.setAttribute('list', 'modelSuggestions');
  // Profile editor model uses its own picker, not the global datalist

  if (this.elements.modelHint && ordered.length > 0) {
    const providerCount = new Set(ordered.map((item) => item.provider)).size;
    this.elements.modelHint.textContent = `Discovered ${ordered.length} models across ${providerCount} providers.`;
  }
};

(SidePanelUI.prototype as any).refreshModelCatalog = async function refreshModelCatalog({ force = false } = {}) {
  const now = Date.now();
  const hasFreshCatalog =
    !force &&
    Array.isArray(this.modelCatalogEntries) &&
    this.modelCatalogEntries.length > 0 &&
    now - Number(this.modelCatalogUpdatedAt || 0) < MODEL_CATALOG_TTL_MS;

  if (hasFreshCatalog) {
    this.applyModelSuggestions();
    return;
  }

  if (this.modelCatalogRefreshPromise) {
    await this.modelCatalogRefreshPromise;
    return;
  }

  this.modelCatalogRefreshPromise = (async () => {
    const discovered: Array<{ provider: string; model: string }> = this.collectConfiguredModelFallbacks();
    const targets = await this.collectModelCatalogTargets();
    const results = await Promise.all(
      targets.map(async (target) => {
        const modelIds = await this.fetchModelIdsForTarget(target);
        return {
          provider: target.provider,
          modelIds,
        };
      }),
    );

    for (const result of results) {
      for (const model of result.modelIds) {
        discovered.push({ provider: result.provider, model });
      }
    }

    const seen = new Set<string>();
    const normalized: Array<{ provider: string; model: string }> = [];
    for (const entry of discovered) {
      const provider = normalizeProvider(entry.provider);
      const model = String(entry.model || '').trim();
      if (!provider || !model) continue;
      const key = `${provider}|${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({ provider, model });
    }

    this.modelCatalogEntries = normalized.slice(0, MAX_MODELS_TOTAL);
    this.modelCatalogUpdatedAt = Date.now();
    this.applyModelSuggestions();
  })();

  try {
    await this.modelCatalogRefreshPromise;
  } finally {
    this.modelCatalogRefreshPromise = null;
  }
};

(SidePanelUI.prototype as any).populateModelSelect = function populateModelSelect() {
  // Try to get the select element - it might not be in this.elements if loaded dynamically
  let select = this.elements.modelSelect;
  if (!select) {
    select = document.getElementById('modelSelect') as HTMLSelectElement;
    if (select) {
      this.elements.modelSelect = select;
    }
  }

  if (!select) {
    console.error('[Parchi] modelSelect element not found!');
    return;
  }

  // Populate with profiles
  select.innerHTML = '';

  const configNames = Object.keys(this.configs);
  if (configNames.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No profiles';
    select.appendChild(option);
    this.updateModelSelectorGlow();
    return;
  }

  for (const name of configNames) {
    const config = this.configs[name];
    const option = document.createElement('option');
    option.value = name; // Use profile name as value

    // Format: icon provider/model (e.g., "🅒 anthropic/claude-sonnet")
    const providerIcon = this.getProviderIcon(config.provider);
    const providerLabel = config.provider || 'unconfigured';
    const modelShort = this.shortenModelName(config.model || 'no-model');
    option.textContent = `${providerIcon} ${providerLabel}/${modelShort}`;

    if (name === this.currentConfig) {
      option.selected = true;
    }
    select.appendChild(option);
  }

  this.updateModelSelectorGlow();
};

(SidePanelUI.prototype as any).refreshModelCatalogForProfileEditor = async function refreshModelCatalogForProfileEditor() {
  const providerEl = this.elements.profileEditorProvider;
  const apiKeyEl = this.elements.profileEditorApiKey;
  const endpointEl = this.elements.profileEditorEndpoint;
  if (!providerEl) return;

  const provider = String(providerEl.value || '').trim().toLowerCase();
  if (!provider) {
    this._profileEditorModels = [];
    this.renderModelPickerList();
    return;
  }

  const apiKey = String(apiKeyEl?.value || '').trim();
  const customEndpoint = String(endpointEl?.value || '').trim();

  const endpointBase = normalizeEndpointBase(provider, customEndpoint);
  if (!endpointBase) {
    this._profileEditorModels = [];
    this.renderModelPickerList();
    return;
  }

  const allowsUnauthedList = provider === 'openrouter' || provider === 'parchi';
  if (!apiKey && !allowsUnauthedList) {
    this._profileEditorModels = [];
    this.renderModelPickerList();
    return;
  }

  // Show loading state
  const listEl = document.getElementById('modelPickerList');
  if (listEl) listEl.innerHTML = '<div class="model-picker-loading">Fetching models...</div>';

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (provider === 'anthropic' || provider === 'kimi') {
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (provider === 'openrouter' || provider === 'parchi') {
    headers['HTTP-Referer'] = 'https://parchi.ai';
    headers['X-Title'] = 'Parchi';
  }

  const target = { key: `editor|${provider}`, provider, endpointBase, headers };
  try {
    const modelIds = await this.fetchModelIdsForTarget(target);
    this._profileEditorModels = modelIds.sort((a: string, b: string) => a.localeCompare(b));
  } catch {
    this._profileEditorModels = [];
  }
  this.renderModelPickerList();
};

(SidePanelUI.prototype as any).renderModelPickerList = function renderModelPickerList(filter?: string) {
  const listEl = document.getElementById('modelPickerList');
  if (!listEl) return;

  const models: string[] = Array.isArray(this._profileEditorModels) ? this._profileEditorModels : [];
  const currentModel = String(this.elements.profileEditorModel?.value || '').trim();
  const query = (filter ?? '').trim().toLowerCase();

  if (!models.length) {
    listEl.innerHTML = '<div class="model-picker-empty">No models found. Check provider, endpoint, and API key.</div>';
    return;
  }

  const filtered = query ? models.filter((m: string) => m.toLowerCase().includes(query)) : models;

  if (!filtered.length) {
    listEl.innerHTML = '<div class="model-picker-empty">No models match filter</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const model of filtered) {
    const item = document.createElement('div');
    item.className = 'model-picker-item';
    if (model === currentModel) item.classList.add('selected');
    item.dataset.model = model;

    if (query) {
      const idx = model.toLowerCase().indexOf(query);
      const before = model.slice(0, idx);
      const match = model.slice(idx, idx + query.length);
      const after = model.slice(idx + query.length);
      item.innerHTML = `${escapeModelHtml(before)}<mark>${escapeModelHtml(match)}</mark>${escapeModelHtml(after)}`;
    } else {
      item.textContent = model;
    }

    listEl.appendChild(item);
  }
};

(SidePanelUI.prototype as any).showModelPicker = function showModelPicker() {
  const dropdown = document.getElementById('modelPickerDropdown');
  if (!dropdown || !dropdown.classList.contains('hidden')) return;
  dropdown.classList.remove('hidden');
  const filterInput = document.getElementById('modelPickerFilter') as HTMLInputElement | null;
  if (filterInput) {
    filterInput.value = '';
    filterInput.focus();
  }
  this.renderModelPickerList();
};

(SidePanelUI.prototype as any).hideModelPicker = function hideModelPicker() {
  const dropdown = document.getElementById('modelPickerDropdown');
  if (dropdown) dropdown.classList.add('hidden');
};

const escapeModelHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

(SidePanelUI.prototype as any).updateModelSelectorGlow = function updateModelSelectorGlow() {
  const wrap = this.elements.modelSelectorWrap || document.getElementById('modelSelectorWrap');
  if (!wrap) return;
  const activeConfig = this.configs?.[this.currentConfig];
  const provider = String(activeConfig?.provider || '').trim().toLowerCase();
  const isParchi = provider === 'parchi' || provider === 'openrouter';
  wrap.classList.toggle('parchi-glow', isParchi);
};

(SidePanelUI.prototype as any).shortenModelName = function shortenModelName(model: string): string {
  if (!model) return 'unknown';
  // Remove common prefixes
  const clean = model
    .replace(/^claude-/, '')
    .replace(/^gpt-/, '')
    .replace(/^kimi-/, '');
  // Truncate if still long
  if (clean.length <= 20) return clean;
  return clean.slice(0, 19) + '…';
};

(SidePanelUI.prototype as any).handleModelSelectChange = async function handleModelSelectChange() {
  const select = this.elements.modelSelect;
  if (!select) return;

  const selectedProfile = select.value;
  if (!selectedProfile || !this.configs[selectedProfile]) return;
  if (selectedProfile === this.currentConfig) return;

  // Switch to the selected profile
  try {
    // setActiveConfig updates in-memory UI state; persistAllSettings ensures the background
    // script (which reads from chrome.storage) uses the same active profile.
    this.setActiveConfig(selectedProfile, true);
    await this.persistAllSettings({ silent: true });
    const selected = this.configs[selectedProfile] || {};
    const providerLabel = selected.provider || 'unconfigured';
    const modelLabel = selected.model || 'no-model';
    this.updateStatus(`已切换到 ${providerLabel}/${modelLabel}`, 'success');
  } catch (error) {
    console.error('[Parchi] Failed to persist selected profile:', error);
    this.updateStatus('切换配置失败', 'error');
  }
};

(SidePanelUI.prototype as any).getProviderIcon = function getProviderIcon(provider: string): string {
  const icons: Record<string, string> = {
    anthropic: '🅒',
    openai: '🅞',
    kimi: '🅚',
    openrouter: '🅡',
    parchi: '🅟',
    custom: '⚙️',
  };
  return icons[provider] || '⚙️';
};
