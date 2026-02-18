const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 60000,
  retries: 0,
  use: {
    headless: false, // Extensions require headed mode in Chromium
  },
  projects: [
    {
      name: 'chromium-extension',
      use: {
        browserName: 'chromium',
      },
    },
  ],
});
