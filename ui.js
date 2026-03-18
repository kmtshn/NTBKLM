/**
 * ui.js - UI Controller Module
 * Handles all DOM interactions, file uploads, previews, status updates, logging,
 * and comprehensive API key management with localStorage persistence.
 */

export class UIController {
  constructor() {
    // DOM references - File handling
    this.dropZone = document.getElementById('dropZone');
    this.fileInput = document.getElementById('fileInput');
    this.fileInfo = document.getElementById('fileInfo');
    this.fileName = document.getElementById('fileName');
    this.removeFileBtn = document.getElementById('removeFileBtn');
    this.previewContainer = document.getElementById('previewContainer');
    this.previewGrid = document.getElementById('previewGrid');
    this.pageCount = document.getElementById('pageCount');

    // DOM references - Actions
    this.convertBtn = document.getElementById('convertBtn');
    this.downloadBtn = document.getElementById('downloadBtn');

    // DOM references - API Key Panel
    this.apiKeyPanel = document.getElementById('apiKeyPanel');
    this.apiKeyInput = document.getElementById('apiKeyInput');
    this.apiKeyToggle = document.getElementById('apiKeyToggle');
    this.saveKeyBtn = document.getElementById('saveKeyBtn');
    this.clearKeyBtn = document.getElementById('clearKeyBtn');
    this.apiKeyStatus = document.getElementById('apiKeyStatus');
    this.apiKeyStatusText = document.getElementById('apiKeyStatusText');

    // DOM references - Header badge
    this.headerKeyBadge = document.getElementById('headerKeyBadge');
    this.headerKeyIcon = document.getElementById('headerKeyIcon');
    this.headerKeyText = document.getElementById('headerKeyText');

    // DOM references - Status & Log
    this.statusList = document.getElementById('statusList');
    this.logContainer = document.getElementById('logContainer');
    this.clearLogBtn = document.getElementById('clearLogBtn');
    this.progressWrapper = document.getElementById('progressWrapper');
    this.progressFill = document.getElementById('progressFill');
    this.progressText = document.getElementById('progressText');

    // DOM references - Modal
    this.modalOverlay = document.getElementById('modalOverlay');
    this.modalImage = document.getElementById('modalImage');
    this.modalClose = document.getElementById('modalClose');

    // DOM references - Other
    this.toastContainer = document.getElementById('toastContainer');
    this.slideSizeSelect = document.getElementById('slideSize');
    this.dpiScaleSelect = document.getElementById('dpiScale');
    this.useInpaintingCheckbox = document.getElementById('useInpainting');

    // State
    this.currentFile = null;
    this.onConvert = null;
    this.onDownload = null;
    this._isProcessing = false;
    this._apiKeyVisible = false;

    // Storage key constants
    this._STORAGE_KEY_API = 'openai_api_key';
    this._STORAGE_KEY_FIRST_VISIT = 'pptx_converter_visited';

    this._initEventListeners();
    this._loadApiKey();
    this._checkFirstVisit();
  }

  // ======================================================================
  // Event Listeners
  // ======================================================================

  _initEventListeners() {
    // -- Drop Zone --
    this.dropZone.addEventListener('click', () => this.fileInput.click());

    this.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dropZone.classList.add('drag-over');
    });

    this.dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dropZone.classList.remove('drag-over');
    });

    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dropZone.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      if (files.length > 0) this._handleFile(files[0]);
    });

    this.fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) this._handleFile(e.target.files[0]);
    });

    // -- Remove file --
    this.removeFileBtn.addEventListener('click', () => this._clearFile());

    // -- Convert button --
    this.convertBtn.addEventListener('click', () => {
      if (this.onConvert && !this._isProcessing) this.onConvert();
    });

    // -- Download button --
    this.downloadBtn.addEventListener('click', () => {
      if (this.onDownload) this.onDownload();
    });

    // -- API Key: Input validation on typing (do NOT auto-save) --
    this.apiKeyInput.addEventListener('input', () => {
      this._validateApiKeyInput();
    });

    // -- API Key: Enter key saves --
    this.apiKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._saveApiKey();
      }
    });

    // -- API Key: Save button --
    this.saveKeyBtn.addEventListener('click', () => this._saveApiKey());

    // -- API Key: Clear button --
    this.clearKeyBtn.addEventListener('click', () => this._clearApiKey());

    // -- API Key: Toggle visibility --
    this.apiKeyToggle.addEventListener('click', () => this._toggleApiKeyVisibility());

    // -- Header badge: scroll to API key panel --
    this.headerKeyBadge.addEventListener('click', () => {
      this.apiKeyPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Flash the panel to draw attention
      this.apiKeyPanel.classList.add('flash');
      setTimeout(() => this.apiKeyPanel.classList.remove('flash'), 1500);
      // Focus the input
      setTimeout(() => this.apiKeyInput.focus(), 500);
    });

    // -- Clear logs --
    this.clearLogBtn.addEventListener('click', () => {
      this.logContainer.innerHTML = '';
    });

    // -- Modal --
    this.modalClose.addEventListener('click', () => this._closeModal());
    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) this._closeModal();
    });

    // -- Keyboard --
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._closeModal();
    });

    // -- Inpainting checkbox: toggle requires API key --
    this.useInpaintingCheckbox.addEventListener('change', () => {
      if (this.useInpaintingCheckbox.checked && !this._hasSavedApiKey()) {
        this.showToast('AI機能を使用するにはAPIキーを保存してください', 'warning');
      }
    });
  }

  // ======================================================================
  // API Key Management
  // ======================================================================

  /**
   * Load API key from localStorage on initialization.
   */
  _loadApiKey() {
    const savedKey = localStorage.getItem(this._STORAGE_KEY_API);
    if (savedKey) {
      this.apiKeyInput.value = savedKey;
      this._setApiKeyStatus('saved');
      this._updateHeaderBadge(true);
    } else {
      this._setApiKeyStatus('empty');
      this._updateHeaderBadge(false);
    }
    this._updateConvertButtonState();
  }

  /**
   * Check if an API key is currently saved in storage.
   */
  _hasSavedApiKey() {
    return !!localStorage.getItem(this._STORAGE_KEY_API);
  }

  /**
   * Validate API key format on input (visual feedback only, no save).
   */
  _validateApiKeyInput() {
    const key = this.apiKeyInput.value.trim();
    this.apiKeyInput.classList.remove('valid', 'invalid');

    if (key.length === 0) {
      // Empty: no validation class
    } else if (key.startsWith('sk-') && key.length >= 20) {
      this.apiKeyInput.classList.add('valid');
    } else if (key.length > 5) {
      this.apiKeyInput.classList.add('invalid');
    }
  }

  /**
   * Save API key to localStorage (explicit save action).
   */
  _saveApiKey() {
    const key = this.apiKeyInput.value.trim();

    if (!key) {
      this.showToast('APIキーを入力してください', 'warning');
      this.apiKeyInput.focus();
      return;
    }

    if (!key.startsWith('sk-')) {
      this.showToast('APIキーは "sk-" で始まる必要があります', 'error');
      this.apiKeyInput.classList.add('invalid');
      this.apiKeyInput.focus();
      return;
    }

    if (key.length < 20) {
      this.showToast('APIキーが短すぎます', 'error');
      this.apiKeyInput.classList.add('invalid');
      this.apiKeyInput.focus();
      return;
    }

    // Save to localStorage
    localStorage.setItem(this._STORAGE_KEY_API, key);

    // Update UI
    this.apiKeyInput.classList.remove('invalid');
    this.apiKeyInput.classList.add('valid');
    this._setApiKeyStatus('saved');
    this._updateHeaderBadge(true);
    this._updateConvertButtonState();

    this.showToast('APIキーを保存しました', 'success');
    this.log('APIキーをブラウザに保存しました', 'success');
  }

  /**
   * Clear API key from localStorage and input.
   */
  _clearApiKey() {
    localStorage.removeItem(this._STORAGE_KEY_API);
    this.apiKeyInput.value = '';
    this.apiKeyInput.classList.remove('valid', 'invalid');
    this._apiKeyVisible = false;
    this.apiKeyInput.type = 'password';
    this.apiKeyToggle.textContent = '\uD83D\uDC41'; // eye icon

    this._setApiKeyStatus('empty');
    this._updateHeaderBadge(false);
    this._updateConvertButtonState();

    this.showToast('APIキーを削除しました', 'info');
    this.log('APIキーをブラウザから削除しました', 'info');
  }

  /**
   * Toggle API key input visibility (password ↔ text).
   */
  _toggleApiKeyVisibility() {
    this._apiKeyVisible = !this._apiKeyVisible;
    this.apiKeyInput.type = this._apiKeyVisible ? 'text' : 'password';
    this.apiKeyToggle.textContent = this._apiKeyVisible ? '\uD83D\uDE48' : '\uD83D\uDC41';
    this.apiKeyToggle.title = this._apiKeyVisible ? '非表示にする' : '表示する';
  }

  /**
   * Update the API key status indicator.
   * @param {'saved'|'empty'|'validating'} status
   */
  _setApiKeyStatus(status) {
    this.apiKeyStatus.classList.remove('saved', 'empty', 'validating');

    switch (status) {
      case 'saved': {
        this.apiKeyStatus.classList.add('saved');
        const key = localStorage.getItem(this._STORAGE_KEY_API) || '';
        const masked = key.length > 8
          ? key.substring(0, 5) + '...' + key.substring(key.length - 4)
          : '****';
        this.apiKeyStatusText.textContent = `APIキーが保存されています (${masked})`;
        this.apiKeyStatus.querySelector('.status-icon').textContent = '\u2705';
        break;
      }
      case 'empty':
        this.apiKeyStatus.classList.add('empty');
        this.apiKeyStatusText.textContent = 'APIキーが設定されていません';
        this.apiKeyStatus.querySelector('.status-icon').textContent = '\u26A0\uFE0F';
        break;
      default:
        break;
    }
  }

  /**
   * Update the header API key badge.
   */
  _updateHeaderBadge(hasKey) {
    this.headerKeyBadge.classList.remove('active', 'inactive');
    if (hasKey) {
      this.headerKeyBadge.classList.add('active');
      this.headerKeyIcon.textContent = '\u2705';
      this.headerKeyText.textContent = 'APIキー設定済み';
    } else {
      this.headerKeyBadge.classList.add('inactive');
      this.headerKeyIcon.textContent = '\u26A0\uFE0F';
      this.headerKeyText.textContent = 'APIキー未設定';
    }
  }

  /**
   * First-visit onboarding check.
   * Shows an info toast and highlights the API key panel.
   */
  _checkFirstVisit() {
    const visited = localStorage.getItem(this._STORAGE_KEY_FIRST_VISIT);
    if (!visited) {
      localStorage.setItem(this._STORAGE_KEY_FIRST_VISIT, 'true');

      // Show onboarding guidance after a short delay
      setTimeout(() => {
        if (!this._hasSavedApiKey()) {
          this.showToast(
            'はじめに OpenAI APIキーを設定してください。AI機能なしでも基本変換は利用できます。',
            'info',
            8000
          );
          // Highlight the panel
          this.apiKeyPanel.classList.add('flash');
          setTimeout(() => this.apiKeyPanel.classList.remove('flash'), 2000);
        }
      }, 800);
    }
  }

  // ======================================================================
  // File Handling
  // ======================================================================

  _handleFile(file) {
    const validTypes = [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
    ];

    // Also check by extension for PPTX (MIME type detection can be unreliable)
    const ext = file.name.toLowerCase().split('.').pop();
    const validExts = ['pptx', 'pdf', 'png', 'jpg', 'jpeg', 'webp'];

    if (!validTypes.includes(file.type) && !validExts.includes(ext)) {
      this.showToast('サポートされていないファイル形式です。PPTX, PDF, PNG, JPG, WEBPに対応しています。', 'error');
      return;
    }

    const maxSize = 100 * 1024 * 1024; // 100MB (PPTX files can be large)
    if (file.size > maxSize) {
      this.showToast('ファイルサイズが大きすぎます（最大100MB）', 'error');
      return;
    }

    this.currentFile = file;
    this.fileName.textContent = `${file.name} (${this._formatSize(file.size)})`;
    this.fileInfo.classList.add('visible');
    this.downloadBtn.style.display = 'none';
    this.downloadBtn.disabled = true;

    this._updateConvertButtonState();
    this.resetStatus();
    this.log(`ファイル選択: ${file.name} (${this._formatSize(file.size)})`, 'info');
  }

  _clearFile() {
    this.currentFile = null;
    this.fileInput.value = '';
    this.fileInfo.classList.remove('visible');
    this.previewContainer.classList.remove('visible');
    this.previewGrid.innerHTML = '';
    this.downloadBtn.style.display = 'none';
    this.downloadBtn.disabled = true;
    this._updateConvertButtonState();
    this.resetStatus();
  }

  _updateConvertButtonState() {
    const hasFile = !!this.currentFile;
    // Allow conversion even without API key (local-only mode)
    // But disable during processing
    this.convertBtn.disabled = !hasFile || this._isProcessing;
  }

  _formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ======================================================================
  // Public API
  // ======================================================================

  /** Get the currently selected file. */
  getFile() { return this.currentFile; }

  /**
   * Get the API key. Returns the saved key from storage, NOT the raw input value.
   * This ensures only explicitly saved keys are used.
   */
  getApiKey() {
    return localStorage.getItem(this._STORAGE_KEY_API) || '';
  }

  /** Check if an API key is available. */
  hasApiKey() {
    return !!this.getApiKey();
  }

  getSlideSize() { return this.slideSizeSelect.value; }

  getDpiScale() { return parseInt(this.dpiScaleSelect.value, 10); }

  getUseInpainting() { return this.useInpaintingCheckbox.checked; }

  isPptx() {
    if (!this.currentFile) return false;
    const ext = this.currentFile.name.toLowerCase().split('.').pop();
    return ext === 'pptx' ||
      this.currentFile.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }

  isPdf() {
    return this.currentFile && this.currentFile.type === 'application/pdf';
  }

  isImage() {
    return this.currentFile && this.currentFile.type.startsWith('image/');
  }

  setProcessing(state) {
    this._isProcessing = state;
    this.convertBtn.disabled = state;
    if (state) {
      this.convertBtn.innerHTML = '<span class="spinner"></span> 処理中...';
      this.progressWrapper.style.display = 'block';
    } else {
      this.convertBtn.innerHTML = '<span>\u26A1</span> 変換開始';
      this._updateConvertButtonState();
    }
  }

  showDownloadButton() {
    this.downloadBtn.style.display = 'inline-flex';
    this.downloadBtn.disabled = false;
  }

  // ======================================================================
  // Preview
  // ======================================================================

  showPreviews(pages) {
    this.previewGrid.innerHTML = '';
    this.pageCount.textContent = `${pages.length} ページ`;

    pages.forEach((page, idx) => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      item.innerHTML = `
        <img src="${page.imageDataUrl}" alt="Page ${idx + 1}">
        <div class="page-label">ページ ${idx + 1}</div>
      `;
      item.addEventListener('click', () => {
        this.modalImage.src = page.imageDataUrl;
        this.modalOverlay.classList.add('visible');
      });
      this.previewGrid.appendChild(item);
    });

    this.previewContainer.classList.add('visible');
  }

  _closeModal() {
    this.modalOverlay.classList.remove('visible');
  }

  // ======================================================================
  // Status
  // ======================================================================

  setStepStatus(stepName, status) {
    const item = this.statusList.querySelector(`[data-step="${stepName}"]`);
    if (!item) return;

    item.classList.remove('active', 'completed', 'error');
    const statusEl = item.querySelector('.step-status');

    switch (status) {
      case 'active':
        item.classList.add('active');
        statusEl.innerHTML = '<span class="spinner"></span>';
        break;
      case 'completed':
        item.classList.add('completed');
        statusEl.textContent = '\u2713';
        break;
      case 'error':
        item.classList.add('error');
        statusEl.textContent = '\u2715';
        break;
      default:
        statusEl.textContent = '';
    }
  }

  resetStatus() {
    const items = this.statusList.querySelectorAll('.status-item');
    items.forEach(item => {
      item.classList.remove('active', 'completed', 'error');
      item.querySelector('.step-status').textContent = '';
    });
    this.setProgress(0);
    this.progressWrapper.style.display = 'none';
  }

  setProgress(percent) {
    const p = Math.min(100, Math.max(0, percent));
    this.progressFill.style.width = p + '%';
    this.progressText.textContent = Math.round(p) + '%';
  }

  // ======================================================================
  // Logging
  // ======================================================================

  log(message, level = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    entry.innerHTML = `<span class="timestamp">[${time}]</span><span class="message">${this._escapeHtml(message)}</span>`;
    this.logContainer.appendChild(entry);
    this.logContainer.scrollTop = this.logContainer.scrollHeight;
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ======================================================================
  // Toast Notifications
  // ======================================================================

  showToast(message, type = 'info', duration = 4000) {
    const icons = { info: '\u2139\uFE0F', success: '\u2705', warning: '\u26A0\uFE0F', error: '\u274C' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || ''}</span><span>${this._escapeHtml(message)}</span>`;
    this.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}
