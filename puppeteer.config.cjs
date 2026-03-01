// puppeteer.config.cjs
const { join } = require('path');

/** @type {import('puppeteer').Configuration} */
module.exports = {
  // Coloca o cache do Puppeteer DENTRO do projeto,
  // para que o Chrome baixado no build vá junto para o runtime do Render.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer')
};
