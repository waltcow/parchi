import { SidePanelUI } from '../core/panel-ui.js';

const parseHeadersJson = (raw: string): Record<string, string> => {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Headers must be a JSON object');
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, value == null ? '' : String(value)]));
};

const formatHeadersJson = (headers: Record<string, any> | undefined) => {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return '';
  const entries = Object.entries(headers).filter(([_, value]) => value != null && String(value).length > 0);
  if (!entries.length) return '';
  const normalized = Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
  return JSON.stringify(normalized, null, 2);
};

const resizeProfilePromptInput = (textarea: HTMLTextAreaElement | null) => {
  if (!textarea) return;
  textarea.style.height = 'auto';
  const nextHeight = Math.min(textarea.scrollHeight, 500);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > 500 ? 'auto' : 'hidden';
};

(SidePanelUI.prototype as any).createNewConfig = async function createNewConfig(name?: string) {
  // Read from whichever input has a value
  const inputA = this.elements.newProfileInput;
  const inputB = this.elements.newProfileNameInput;
  const trimmedName = (name || inputA?.value || inputB?.value || '').trim();
  if (!trimmedName) {
    this.updateStatus('Enter a profile name', 'warning');
    return;
  }
  if (this.configs[trimmedName]) {
    this.updateStatus('Profile already exists', 'warning');
    return;
  }

  // Clear both inputs
  if (inputA) inputA.value = '';
  if (inputB) inputB.value = '';

  // Clone the current active config so the new profile starts with sane defaults
  const current = this.configs[this.currentConfig] || {};
  this.configs[trimmedName] = {
    provider: current.provider ?? '',
    apiKey: current.apiKey ?? '',
    model: current.model ?? '',
    customEndpoint: current.customEndpoint ?? '',
    extraHeaders: current.extraHeaders || {},
    systemPrompt: current.systemPrompt || '',
    temperature: current.temperature ?? 0.7,
    maxTokens: current.maxTokens || 4096,
    contextLimit: current.contextLimit || 200000,
    timeout: current.timeout || 30000,
    sendScreenshotsAsImages: current.sendScreenshotsAsImages || false,
    screenshotQuality: current.screenshotQuality || 'high',
    streamResponses: current.streamResponses !== false,
    enableScreenshots: current.enableScreenshots || false,
    saveHistory: current.saveHistory !== false,
    showThinking: current.showThinking !== false,
    autoScroll: current.autoScroll !== false,
    confirmActions: current.confirmActions !== false,
  };

  this.refreshConfigDropdown();
  this.setActiveConfig(trimmedName, true);
  await this.persistAllSettings({ silent: true });
  this.updateStatus(`Profile "${trimmedName}" created`, 'success');
};

(SidePanelUI.prototype as any).deleteConfig = async function deleteConfig() {
  if (this.currentConfig === 'default') {
    this.updateStatus('Cannot delete default profile', 'warning');
    return;
  }
  await this.deleteProfileByName(this.currentConfig);
};

(SidePanelUI.prototype as any).deleteProfileByName = async function deleteProfileByName(name: string) {
  if (!name || name === 'default') {
    this.updateStatus('Cannot delete default profile', 'warning');
    return;
  }
  if (!this.configs[name]) return;

  delete this.configs[name];
  if (this.currentConfig === name) {
    this.currentConfig = 'default';
  }
  if (this.profileEditorTarget === name) {
    this.profileEditorTarget = this.currentConfig;
    this.editProfile(this.currentConfig, true);
  }
  this.refreshConfigDropdown();
  this.updateModelDisplay();
  this.setActiveConfig(this.currentConfig, true);
  await this.persistAllSettings({ silent: true });
  this.updateStatus(`Profile "${name}" deleted`, 'success');
};

(SidePanelUI.prototype as any).switchConfig = async function switchConfig() {
  const newConfig = this.elements.activeConfig.value;
  if (!this.configs[newConfig]) {
    this.updateStatus('Profile not found', 'warning');
    return;
  }
  this.configs[this.currentConfig] = this.collectCurrentFormProfile();
  this.setActiveConfig(newConfig);
  await this.persistAllSettings({ silent: true });
};

(SidePanelUI.prototype as any).refreshConfigDropdown = function refreshConfigDropdown() {
  if (this.elements.activeConfig) {
    this.elements.activeConfig.innerHTML = '';
    Object.keys(this.configs).forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      if (name === this.currentConfig) {
        option.selected = true;
      }
      this.elements.activeConfig.appendChild(option);
    });
  }
  this.refreshProfileSelectors();
  this.updateModelDisplay();
  this.renderProfileGrid();
  this.updateContextUsage();
};

(SidePanelUI.prototype as any).refreshProfileSelectors = function refreshProfileSelectors() {
  const names = Object.keys(this.configs);
  const selects = [this.elements.orchestratorProfile, this.elements.visionProfile];
  selects.forEach((select) => {
    if (!select) return;
    select.innerHTML = '<option value="">Use active config</option>';
    names.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

    const currentValue = select.value;
    if (!currentValue) return;
    if (!names.includes(currentValue)) {
      select.value = '';
    }
  });
};

(SidePanelUI.prototype as any).renderProfileGrid = function renderProfileGrid() {
  if (!this.elements.agentGrid) return;
  this.elements.agentGrid.innerHTML = '';
  const currentVision = this.elements.visionProfile?.value;
  const currentOrchestrator = this.elements.orchestratorProfile?.value;
  const configs = Object.keys(this.configs);
  if (!configs.length) {
    this.elements.agentGrid.innerHTML = '<div class="history-empty">No profiles yet.</div>';
    return;
  }
  configs.forEach((name) => {
    const card = document.createElement('div');
    card.className = 'agent-card';
    if (name === this.profileEditorTarget) {
      card.classList.add('editing');
    }
    card.dataset.profile = name;
    const rolePills = ['main', 'vision', 'orchestrator', 'aux']
      .map((role) => {
        const isActive = this.isProfileActiveForRole(name, role, currentVision, currentOrchestrator);
        const label = this.getRoleLabel(role);
        return `<span class="role-pill ${isActive ? 'active' : ''} ${role}-pill" data-role="${role}" data-profile="${name}">${label}</span>`;
      })
      .join('');
    const config = this.configs[name] || {};
    const deleteBtn =
      name !== 'default'
        ? `<button class="agent-card-delete" data-delete-profile="${this.escapeHtml(name)}" title="Delete profile">&times;</button>`
        : '';
    card.innerHTML = `
        <div class="agent-card-header">
          <div>
            <h4>${this.escapeHtml(name)}</h4>
            <span>${this.escapeHtml(config.provider || 'Provider')} · ${this.escapeHtml(config.model || 'Model')}</span>
          </div>
          ${deleteBtn}
        </div>
        <div class="role-pills">${rolePills}</div>
      `;
    this.elements.agentGrid.appendChild(card);
  });
};

(SidePanelUI.prototype as any).getRoleLabel = function getRoleLabel(role: string) {
  switch (role) {
    case 'main':
      return 'Main';
    case 'vision':
      return 'Vision';
    case 'orchestrator':
      return 'Orchestrator';
    default:
      return 'Team';
  }
};

(SidePanelUI.prototype as any).isProfileActiveForRole = function isProfileActiveForRole(
  name: string,
  role: string,
  visionName?: string,
  orchestratorName?: string,
) {
  if (role === 'main') return name === this.currentConfig;
  if (role === 'vision') return name && visionName === name;
  if (role === 'orchestrator') return name && orchestratorName === name;
  if (role === 'aux') return this.auxAgentProfiles.includes(name);
  return false;
};

(SidePanelUI.prototype as any).assignProfileRole = function assignProfileRole(profileName: string, role: string) {
  if (!profileName) return;
  if (role === 'main') {
    this.setActiveConfig(profileName);
    return;
  }
  if (role === 'vision') {
    this.toggleProfileRole('visionProfile', profileName);
  } else if (role === 'orchestrator') {
    this.toggleProfileRole('orchestratorProfile', profileName);
  } else if (role === 'aux') {
    this.toggleAuxProfile(profileName);
  }
};

(SidePanelUI.prototype as any).toggleProfileRole = function toggleProfileRole(elementId: string, profileName: string) {
  const element = this.elements[elementId];
  if (!element) return;
  element.value = element.value === profileName ? '' : profileName;
  this.renderProfileGrid();
};

(SidePanelUI.prototype as any).toggleAuxProfile = function toggleAuxProfile(profileName: string) {
  const idx = this.auxAgentProfiles.indexOf(profileName);
  if (idx === -1) {
    this.auxAgentProfiles.push(profileName);
  } else {
    this.auxAgentProfiles.splice(idx, 1);
  }
  this.auxAgentProfiles = Array.from(new Set(this.auxAgentProfiles));
  this.renderProfileGrid();
};

(SidePanelUI.prototype as any).editProfile = function editProfile(name: string, silent = false) {
  if (!name || !this.configs[name]) return;
  this.profileEditorTarget = name;
  const config = this.configs[name];

  // Only update profile editor elements if they exist
  if (this.elements.profileEditorTitle) this.elements.profileEditorTitle.textContent = `Editing: ${name}`;
  if (this.elements.profileEditorName) this.elements.profileEditorName.value = name;
  if (this.elements.profileEditorProvider) this.elements.profileEditorProvider.value = config.provider || '';
  if (this.elements.profileEditorApiKey) this.elements.profileEditorApiKey.value = config.apiKey || '';
  if (this.elements.profileEditorModel) this.elements.profileEditorModel.value = config.model || '';
  if (this.elements.profileEditorEndpoint) this.elements.profileEditorEndpoint.value = config.customEndpoint || '';
  if (this.elements.profileEditorHeaders)
    this.elements.profileEditorHeaders.value = formatHeadersJson(config.extraHeaders) || '';
  if (this.elements.profileEditorTemperature) {
    this.elements.profileEditorTemperature.value = config.temperature ?? 0.7;
    if (this.elements.profileEditorTemperatureValue) {
      this.elements.profileEditorTemperatureValue.textContent = this.elements.profileEditorTemperature.value;
    }
  }
  if (this.elements.profileEditorMaxTokens) this.elements.profileEditorMaxTokens.value = config.maxTokens || 2048;
  if (this.elements.profileEditorContextLimit)
    this.elements.profileEditorContextLimit.value = config.contextLimit || 200000;
  if (this.elements.profileEditorTimeout) this.elements.profileEditorTimeout.value = config.timeout || 30000;
  if (this.elements.profileEditorEnableScreenshots)
    this.elements.profileEditorEnableScreenshots.value = config.enableScreenshots ? 'true' : 'false';
  if (this.elements.profileEditorSendScreenshots)
    this.elements.profileEditorSendScreenshots.value = config.sendScreenshotsAsImages ? 'true' : 'false';
  if (this.elements.profileEditorScreenshotQuality)
    this.elements.profileEditorScreenshotQuality.value = config.screenshotQuality || 'high';
  if (this.elements.profileEditorShowThinking)
    this.elements.profileEditorShowThinking.value = config.showThinking !== false ? 'true' : 'false';
  if (this.elements.profileEditorStreamResponses)
    this.elements.profileEditorStreamResponses.value = config.streamResponses !== false ? 'true' : 'false';
  if (this.elements.profileEditorAutoScroll)
    this.elements.profileEditorAutoScroll.value = config.autoScroll !== false ? 'true' : 'false';
  if (this.elements.profileEditorConfirmActions)
    this.elements.profileEditorConfirmActions.value = config.confirmActions !== false ? 'true' : 'false';
  if (this.elements.profileEditorSaveHistory)
    this.elements.profileEditorSaveHistory.value = config.saveHistory !== false ? 'true' : 'false';
  if (this.elements.profileEditorPrompt)
    this.elements.profileEditorPrompt.value = config.systemPrompt || this.getDefaultSystemPrompt();
  resizeProfilePromptInput(this.elements.profileEditorPrompt);

  this.toggleProfileEditorEndpoint();
  this.refreshProfileJsonEditor?.();
  this.refreshModelCatalogForProfileEditor?.();
  this.renderProfileGrid();
  if (!silent) {
    this.switchSettingsTab('profiles');
  }
};

(SidePanelUI.prototype as any).collectProfileEditorData = function collectProfileEditorData() {
  return {
    provider: this.elements.profileEditorProvider.value,
    apiKey: this.elements.profileEditorApiKey.value,
    model: this.elements.profileEditorModel.value,
    customEndpoint: this.elements.profileEditorEndpoint.value,
    extraHeaders: (() => {
      const raw = this.elements.profileEditorHeaders?.value || '';
      if (!raw.trim()) return {};
      try {
        return parseHeadersJson(raw);
      } catch {
        return {};
      }
    })(),
    temperature: Number.parseFloat(this.elements.profileEditorTemperature.value) || 0.7,
    maxTokens: Number.parseInt(this.elements.profileEditorMaxTokens.value) || 2048,
    contextLimit: Number.parseInt(this.elements.profileEditorContextLimit?.value || '') || 200000,
    timeout: Number.parseInt(this.elements.profileEditorTimeout.value) || 30000,
    enableScreenshots: this.elements.profileEditorEnableScreenshots.value === 'true',
    sendScreenshotsAsImages: this.elements.profileEditorSendScreenshots.value === 'true',
    screenshotQuality: this.elements.profileEditorScreenshotQuality.value || 'high',
    showThinking: this.elements.profileEditorShowThinking?.value !== 'false',
    streamResponses: this.elements.profileEditorStreamResponses?.value !== 'false',
    autoScroll: this.elements.profileEditorAutoScroll?.value !== 'false',
    confirmActions: this.elements.profileEditorConfirmActions?.value !== 'false',
    saveHistory: this.elements.profileEditorSaveHistory?.value !== 'false',
    systemPrompt: this.elements.profileEditorPrompt.value || this.getDefaultSystemPrompt(),
  };
};

(SidePanelUI.prototype as any).saveProfileEdits = async function saveProfileEdits() {
  const target = this.profileEditorTarget;
  if (!target || !this.configs[target]) {
    this.updateStatus('Select a profile to edit', 'warning');
    return;
  }
  if (!this.validateProfileEditorHeaders?.()) {
    this.updateStatus('Invalid headers JSON', 'error');
    return;
  }

  const newName = (this.elements.profileEditorName?.value || '').trim();
  const isRename = newName && newName !== target;

  if (isRename) {
    if (!newName) {
      this.updateStatus('Profile name cannot be empty', 'warning');
      return;
    }
    if (this.configs[newName]) {
      this.updateStatus(`Profile "${newName}" already exists`, 'warning');
      return;
    }
    if (target === 'default') {
      this.updateStatus('Cannot rename the default profile', 'warning');
      return;
    }
  }

  const existing = this.configs[target] || {};
  const updated = { ...existing, ...this.collectProfileEditorData() };

  if (isRename) {
    // Move config to new key
    this.configs[newName] = updated;
    delete this.configs[target];

    // Update references
    if (this.currentConfig === target) this.currentConfig = newName;
    this.profileEditorTarget = newName;

    // Update role selectors if they referenced the old name
    if (this.elements.visionProfile?.value === target) this.elements.visionProfile.value = newName;
    if (this.elements.orchestratorProfile?.value === target) this.elements.orchestratorProfile.value = newName;
    const auxIdx = this.auxAgentProfiles.indexOf(target);
    if (auxIdx !== -1) this.auxAgentProfiles[auxIdx] = newName;

    if (this.elements.profileEditorTitle) this.elements.profileEditorTitle.textContent = `Editing: ${newName}`;
    this.refreshConfigDropdown();
    await this.persistAllSettings({ silent: true });
    this.updateStatus(`Profile renamed to "${newName}"`, 'success');
  } else {
    this.configs[target] = updated;
    await this.persistAllSettings({ silent: true });
    if (target === this.currentConfig) {
      this.populateFormFromConfig(this.configs[target]);
      this.toggleCustomEndpoint();
    }
    this.renderProfileGrid();
    this.updateStatus(`Profile "${target}" saved`, 'success');
  }
};

(SidePanelUI.prototype as any).populateFormFromConfig = function populateFormFromConfig(
  config: Record<string, any> = {},
) {
  // Use optional chaining for all element accesses since settings UI may be simplified
  if (this.elements.provider) this.elements.provider.value = config.provider || '';
  if (this.elements.apiKey) this.elements.apiKey.value = config.apiKey || '';
  if (this.elements.model) this.elements.model.value = config.model || '';
  if (this.elements.customEndpoint) this.elements.customEndpoint.value = config.customEndpoint || '';
  if (this.elements.customHeaders) this.elements.customHeaders.value = formatHeadersJson(config.extraHeaders) || '';
  if (this.elements.systemPrompt)
    this.elements.systemPrompt.value = config.systemPrompt || this.getDefaultSystemPrompt();
  if (this.elements.temperature) {
    this.elements.temperature.value = config.temperature !== undefined ? config.temperature : 0.7;
    if (this.elements.temperatureValue) {
      this.elements.temperatureValue.textContent = this.elements.temperature.value;
    }
  }
  if (this.elements.maxTokens) this.elements.maxTokens.value = config.maxTokens || 4096;
  if (this.elements.contextLimit) this.elements.contextLimit.value = config.contextLimit || 200000;
  if (this.elements.timeout) this.elements.timeout.value = config.timeout || 30000;
  if (this.elements.enableScreenshots)
    this.elements.enableScreenshots.value = config.enableScreenshots ? 'true' : 'false';
  if (this.elements.sendScreenshotsAsImages)
    this.elements.sendScreenshotsAsImages.value = config.sendScreenshotsAsImages ? 'true' : 'false';
  if (this.elements.screenshotQuality) this.elements.screenshotQuality.value = config.screenshotQuality || 'high';
  if (this.elements.streamResponses)
    this.elements.streamResponses.value = config.streamResponses !== false ? 'true' : 'false';
  if (this.elements.showThinking) this.elements.showThinking.value = config.showThinking !== false ? 'true' : 'false';
  if (this.elements.autoScroll) this.elements.autoScroll.value = config.autoScroll !== false ? 'true' : 'false';
  if (this.elements.confirmActions)
    this.elements.confirmActions.value = config.confirmActions !== false ? 'true' : 'false';
  if (this.elements.saveHistory) this.elements.saveHistory.value = config.saveHistory !== false ? 'true' : 'false';
};

(SidePanelUI.prototype as any).setActiveConfig = function setActiveConfig(name: string, quiet = false) {
  if (!this.configs[name]) return;
  this.currentConfig = name;
  if (this.elements.activeConfig) this.elements.activeConfig.value = name;
  this.populateFormFromConfig(this.configs[name]);
  this.toggleCustomEndpoint();
  this.renderProfileGrid?.();
  this.updateScreenshotToggleState?.();
  this.editProfile?.(name, true);
  this.fetchAvailableModels(); // This now repopulates the composer dropdown with all profiles
  if (!quiet) {
    this.updateStatus(`已切换到 "${name}"`, 'success');
  }
};

(SidePanelUI.prototype as any).refreshProfileJsonEditor = function refreshProfileJsonEditor() {
  if (!this.elements.profileJsonEditor) return;
  const target = this.profileEditorTarget || this.currentConfig;
  const config = this.configs[target] || {};
  this.elements.profileJsonEditor.value = JSON.stringify(config, null, 2);
};

(SidePanelUI.prototype as any).copyProfileJsonEditor = async function copyProfileJsonEditor() {
  if (!this.elements.profileJsonEditor) return;
  const text = this.elements.profileJsonEditor.value || '';
  if (!text.trim()) {
    this.updateStatus('Profile JSON is empty', 'warning');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    this.updateStatus('Profile JSON copied', 'success');
  } catch {
    this.updateStatus('Unable to copy profile JSON', 'error');
  }
};

(SidePanelUI.prototype as any).applyProfileJsonEditor = async function applyProfileJsonEditor() {
  if (!this.elements.profileJsonEditor) return;
  const target = this.profileEditorTarget || this.currentConfig;
  if (!target || !this.configs[target]) {
    this.updateStatus('Select a profile to edit', 'warning');
    return;
  }
  const raw = this.elements.profileJsonEditor.value || '';
  if (!raw.trim()) {
    this.updateStatus('Paste profile JSON first', 'warning');
    return;
  }
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    this.updateStatus('Invalid JSON format', 'error');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    this.updateStatus('Profile JSON must be an object', 'error');
    return;
  }
  const existing = this.configs[target] || {};
  if (parsed.extraHeaders && typeof parsed.extraHeaders === 'string') {
    try {
      parsed.extraHeaders = parseHeadersJson(parsed.extraHeaders);
    } catch {
      parsed.extraHeaders = existing.extraHeaders || {};
    }
  }
  this.configs[target] = { ...existing, ...parsed };
  await this.persistAllSettings({ silent: true });
  this.editProfile(target, true);
  if (target === this.currentConfig) {
    this.populateFormFromConfig(this.configs[target]);
  }
  this.updateStatus(`Profile "${target}" updated`, 'success');
};
