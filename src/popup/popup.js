'use strict';

const FORMAT_IDS = ['html', 'markdown', 'png', 'pdf'];

const $archive = document.getElementById('btn-archive');
const $status = document.getElementById('status');
const $progress = document.getElementById('progress');
const $progressBar = document.getElementById('progress-bar');
const $results = document.getElementById('results');
const $options = document.getElementById('btn-options');

// Load saved format preferences
chrome.storage.sync.get({ formats: { html: true, markdown: true, png: true, pdf: true } }, (data) => {
  for (const fmt of FORMAT_IDS) {
    document.getElementById(`fmt-${fmt}`).checked = data.formats[fmt] !== false;
  }
});

// Save format preferences on change
for (const fmt of FORMAT_IDS) {
  document.getElementById(`fmt-${fmt}`).addEventListener('change', () => {
    const formats = {};
    for (const f of FORMAT_IDS) {
      formats[f] = document.getElementById(`fmt-${f}`).checked;
    }
    chrome.storage.sync.set({ formats });
  });
}

function getSelectedFormats() {
  const formats = [];
  for (const fmt of FORMAT_IDS) {
    if (document.getElementById(`fmt-${fmt}`).checked) {
      formats.push(fmt);
    }
  }
  return formats;
}

function setStatus(message, type = 'info') {
  $status.textContent = message;
  $status.className = `status ${type}`;
  $status.classList.remove('hidden');
}

function setProgress(pct) {
  $progress.classList.remove('hidden');
  $progressBar.style.width = `${pct}%`;
}

function showResults(items) {
  $results.innerHTML = '';
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'result-item';
    const icon = document.createElement('span');
    icon.className = 'result-icon';
    icon.textContent = item.success ? '\u2713' : '\u2717';
    icon.style.color = item.success ? '#16a34a' : '#dc2626';
    const label = document.createElement('span');
    label.textContent = item.label;
    div.appendChild(icon);
    div.appendChild(label);
    $results.appendChild(div);
  }
  $results.classList.remove('hidden');
}

$archive.addEventListener('click', async () => {
  const formats = getSelectedFormats();
  if (formats.length === 0) {
    setStatus('Select at least one format.', 'error');
    return;
  }

  $archive.disabled = true;
  $results.classList.add('hidden');
  setStatus('Archiving...', 'info');
  setProgress(10);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'archive',
      formats,
    });

    if (response && response.error) {
      setStatus(response.error, 'error');
      setProgress(0);
      $progress.classList.add('hidden');
    } else if (response && response.results) {
      setProgress(100);
      const total = response.results.length;
      const succeeded = response.results.filter((r) => r.success).length;
      setStatus(
        `Archived ${succeeded}/${total} format${total !== 1 ? 's' : ''}.`,
        succeeded === total ? 'success' : 'error'
      );
      showResults(response.results);
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    $archive.disabled = false;
  }
});

$options.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Listen for progress updates from the service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'archive-progress') {
    setProgress(msg.percent);
    if (msg.label) {
      setStatus(msg.label, 'info');
    }
  }
});
