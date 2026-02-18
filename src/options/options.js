'use strict';

const DEFAULTS = {
  formats: { html: true, markdown: true, png: true, pdf: true, printpdf: true },
  filenamePattern: '{date}_{hostname}_{title}',
  subfolder: '',
  bundleAsZip: true,
};

const FORMAT_IDS = ['html', 'markdown', 'png', 'pdf', 'printpdf'];

function loadOptions() {
  chrome.storage.sync.get(DEFAULTS, (data) => {
    for (const fmt of FORMAT_IDS) {
      document.getElementById(`opt-${fmt}`).checked = data.formats[fmt] !== false;
    }
    document.getElementById('opt-pattern').value = data.filenamePattern || DEFAULTS.filenamePattern;
    document.getElementById('opt-subfolder').value = data.subfolder || '';
    document.getElementById('opt-zip').checked = data.bundleAsZip !== false;
  });
}

function saveOptions() {
  const formats = {};
  for (const fmt of FORMAT_IDS) {
    formats[fmt] = document.getElementById(`opt-${fmt}`).checked;
  }

  const options = {
    formats,
    filenamePattern: document.getElementById('opt-pattern').value.trim() || DEFAULTS.filenamePattern,
    subfolder: document.getElementById('opt-subfolder').value.trim(),
    bundleAsZip: document.getElementById('opt-zip').checked,
  };

  chrome.storage.sync.set(options, () => {
    const msg = document.getElementById('saved-msg');
    msg.classList.add('visible');
    setTimeout(() => msg.classList.remove('visible'), 2000);
  });
}

function resetOptions() {
  chrome.storage.sync.set(DEFAULTS, () => {
    loadOptions();
    const msg = document.getElementById('saved-msg');
    msg.textContent = 'Reset';
    msg.classList.add('visible');
    setTimeout(() => {
      msg.classList.remove('visible');
      msg.textContent = 'Saved';
    }, 2000);
  });
}

document.getElementById('btn-save').addEventListener('click', saveOptions);
document.getElementById('btn-reset').addEventListener('click', resetOptions);

loadOptions();
