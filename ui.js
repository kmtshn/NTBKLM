/**
 * ui.js - UI Controller Module
 * Handles all DOM interactions, file uploads, previews, status updates, and logging.
 */

export class UIController {
  constructor() {
    // DOM references
    this.dropZone = document.getElementById('dropZone');
    this.fileInput = document.getElementById('fileInput');
    this.fileInfo = document.getElementById('fileInfo');
    this.fileName = document.getElementById('fileName');
    this.removeFileBtn = document.getElementById('removeFileBtn');
    this.previewContainer = document.getElementById('previewContainer');
    this.previewGrid = document.getElementById('previewGrid');
    this.pageCount = document.getElementById('pageCount');
    this.convertBtn = document.getElementById('convertBtn');
    this.downloadBtn = document.getElementById('downloadBtn');
    this.apiKeyInput = document.getElementById('apiKeyInput');
    this.statusList = document.getElementById('statusList');
    this.logContainer = document.getElementById('logContainer');
    this.clearLogBtn = document.getElementById('clearLogBtn');
    this.progressWrapper = document.getElementById('progressWrapper');
    this.progressFill = document.getElementById('progressFill');
    this.progressText = document.getElementById('progressText');
    this.modalOverlay = document.getElementById('modalOverlay');
    this.modalImage = document.getElementById('modalImage');
    this.modalClose = document.getElementById('modalClose');
    this.toastContainer = document.getElementById('toastContainer');
    this.slideSizeSelect = document.getElementById('slideSize');
    this.dpiScaleSelect = document.getElementById('dpiScale');
    this.useInpaintingCheckbox = document.getElementById('useInpainting');

    // State
    this.currentFile = null;
    this.onConvert = null; // callback
    this.onDownload = null; // callback
    this._isProcessing = false;

    this._initEventListeners();
    this._loadApiKey();
  }

  _initEventListeners() {
    // Drop zone events
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

    // Remove file
    this.removeFileBtn.addEventListener('click', () => this._clearFile());

    // Convert button
    this.convertBtn.addEventListener('click', () => {
      if (this.onConvert && !this._isProcessing) this.onConvert();
    });

    // Download button
    this.downloadBtn.addEventListener('click', () => {
      if (this.onDownload) this.onDownload();
    });

    // API key persistence
    this.apiKeyInput.addEventListener('input', () => {
      const key = this.apiKeyInput.value.trim();
      if (key) {
        localStorage.setItem('openai_api_key', key);
        this.apiKeyInput.classList.remove('invalid');
        if (key.startsWith('sk-')) {
          this.apiKeyInput.classList.add('valid');
        }
      } else {
        this.apiKeyInput.classList.remove('valid', 'invalid');
      }
      this._updateConvertButtonState();
    });

    // Clear logs
    this.clearLogBtn.addEventListener('click', () => {
      this.logContainer.innerHTML = '';
    });

    // Modal
    this.modalClose.addEventListener('click', () => this._closeModal());
    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) this._closeModal();
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._closeModal();
    });
  }

  _loadApiKey() {
    const savedKey = localStorage.getItem('openai_api_key');
    if (savedKey) {
      this.apiKeyInput.value = savedKey;
      if (savedKey.startsWith('sk-')) {
        this.apiKeyInput.classList.add('valid');
      }
    }
  }

  _handleFile(file) {
    const validTypes = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
    ];

    if (!validTypes.includes(file.type)) {
      this.showToast('サポートされていないファイル形式です。PDF, PNG, JPG, WEBPに対応しています。', 'error');
      return;
    }

    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      this.showToast('ファイルサイズが大きすぎます（最大50MB）', 'error');
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
    const hasKey = !!this.apiKeyInput.value.trim();
    this.convertBtn.disabled = !hasFile || !hasKey || this._isProcessing;
  }

  _formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // -- Public API --

  getFile() { return this.currentFile; }

  getApiKey() { return this.apiKeyInput.value.trim(); }

  getSlideSize() { return this.slideSizeSelect.value; }

  getDpiScale() { return parseInt(this.dpiScaleSelect.value, 10); }

  getUseInpainting() { return this.useInpaintingCheckbox.checked; }

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
      this.convertBtn.innerHTML = '<span>⚡</span> 変換開始';
      this._updateConvertButtonState();
    }
  }

  showDownloadButton() {
    this.downloadBtn.style.display = 'inline-flex';
    this.downloadBtn.disabled = false;
  }

  // Preview
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

  // Status
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
        statusEl.textContent = '✓';
        break;
      case 'error':
        item.classList.add('error');
        statusEl.textContent = '✕';
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

  // Logging
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

  // Toast notifications
  showToast(message, type = 'info', duration = 4000) {
    const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' };
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
