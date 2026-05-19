const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Tray,
  Menu,
  screen,
  desktopCapturer,
  nativeImage,
  clipboard,
  session
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const Store = require('electron-store');

const APP_ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const APP_TRAY_ICON_PATH = path.join(__dirname, '..', 'assets', 'icon_16.png');
const BRAND_LOGO_CSS_PATH = path.join(__dirname, 'brand-logo.css');
let cachedBrandLogoDataUrl = null;
let cachedBrandLogoImage = null;

function getBrandLogoDataUrl() {
  if (cachedBrandLogoDataUrl) return cachedBrandLogoDataUrl;
  const css = fs.readFileSync(BRAND_LOGO_CSS_PATH, 'utf8');
  const match = css.match(/url\("(data:image\/png;base64,[^"]+)"\)/);
  cachedBrandLogoDataUrl = match ? match[1] : '';
  return cachedBrandLogoDataUrl;
}

function getAppIconImage(size) {
  if (!cachedBrandLogoImage) {
    const dataUrl = getBrandLogoDataUrl();
    cachedBrandLogoImage = dataUrl ? nativeImage.createFromDataURL(dataUrl) : nativeImage.createFromPath(APP_ICON_PATH);
  }
  if (size && !cachedBrandLogoImage.isEmpty()) return cachedBrandLogoImage.resize({ width: size, height: size, quality: 'best' });
  return cachedBrandLogoImage;
}

/* ─────────────────── Startup / Storage Configuration ─────────────────── */

function ensureDirectory(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (err) {
    console.warn('[startup] Unable to create directory:', dirPath, err.message);
    return false;
  }
}

function getWritableAppDataRoot() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  try {
    return app.getPath('appData');
  } catch (_) {
    return path.join(os.homedir(), '.config');
  }
}

function configureChromiumStorage() {
  const appDataRoot = getWritableAppDataRoot();
  const storageRoot = path.join(appDataRoot, 'SilentGPT');
  const sessionDataPath = path.join(storageRoot, 'Session Data');
  const diskCachePath = path.join(storageRoot, 'Cache');

  ensureDirectory(sessionDataPath);
  ensureDirectory(diskCachePath);

  try { app.setPath('sessionData', sessionDataPath); } catch (err) { console.warn('[startup] Unable to set sessionData path:', err.message); }
  try { app.commandLine.appendSwitch('disk-cache-dir', diskCachePath); } catch (_) {}
}

configureChromiumStorage();

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  const visibleWindow = BrowserWindow.getAllWindows().find((win) => win && !win.isDestroyed() && win.isVisible());
  if (visibleWindow) {
    try { if (visibleWindow.isMinimized()) visibleWindow.restore(); } catch (_) {}
    try { visibleWindow.focus(); } catch (_) {}
  } else if (typeof showActivate === 'function' && store && !isAppUnlocked()) {
    showActivate();
  } else if (typeof makeSettings === 'function') {
    makeSettings();
  }
});


// Remove Electron's default application menu (File/Edit/View/Window/Help) from all app windows.
// Individual tray menus still use Menu.buildFromTemplate and are unaffected.
try { Menu.setApplicationMenu(null); } catch (_) {}

function framelessWindowOptions() {
  return {
    icon: getAppIconImage(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden'
  };
}

/* ─────────────────── Environment Configuration ─────────────────── */

function getLocalEnvironmentCandidateFiles() {
  const candidateFiles = [
    // Development checkout: /path/to/SilentGPT/.env
    path.join(__dirname, '..', '.env'),
    // Shell launch location: npm start, electron ., or manual CLI launch.
    path.join(process.cwd(), '.env'),
    // Packaged desktop app: keep .env next to SilentGPT.exe/SilentGPT.app launcher.
    path.join(path.dirname(process.execPath), '.env'),
    // Electron resources folder, useful for portable builds.
    process.resourcesPath ? path.join(process.resourcesPath, '.env') : '',
    // User-level fallback for installed apps.
    path.join(os.homedir(), '.silentgpt.env'),
    path.join(os.homedir(), '.config', 'SilentGPT', '.env')
  ];

  try {
    candidateFiles.push(path.join(app.getPath('userData'), '.env'));
  } catch (_) {
    // app.getPath can be unavailable in unusual early-startup contexts.
  }

  return [...new Set(candidateFiles.filter(Boolean))];
}

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim().replace(/^\uFEFF/, '');
    if (!trimmed || trimmed.startsWith('#')) return;
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) return;
    const rawKey = trimmed.slice(0, equalsIndex).trim();
    const key = rawKey.replace(/^export\s+/, '').trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key] !== undefined) return;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
  return true;
}

function loadLocalEnvironment() {
  return getLocalEnvironmentCandidateFiles().filter(loadDotEnvFile);
}

const LOADED_ENV_FILES = loadLocalEnvironment();

/* ─────────────────── Persistent Settings ─────────────────── */

// API keys are loaded from the runtime/build environment. Do not hardcode live
// secrets in the desktop bundle; use these environment variables when packaging.
const API_PLACEHOLDER = 'YOUR_PERPLEXITY' + '_API_KEY';
const BUILT_IN_API_KEY = process.env.SILENTGPT_PERPLEXITY_API_KEY || API_PLACEHOLDER;
const OPENAI_KEY_PLACEHOLDER = 'YOUR_OPENAI' + '_API_KEY';
const OPENAI_API_KEY = process.env.SILENTGPT_OPENAI_API_KEY || OPENAI_KEY_PLACEHOLDER;

// Stripe configuration — use environment variables during packaging/deployment.
// Keep the secret key on a trusted machine/backend; never commit a live key.
const STRIPE_KEY_PLACEHOLDER = 'YOUR_STRIPE' + '_SECRET_KEY';
const STRIPE_PRICE_PLACEHOLDER = 'YOUR_STRIPE' + '_PRICE_ID';
const STRIPE_SECRET_KEY = process.env.SILENTGPT_STRIPE_SECRET_KEY || STRIPE_KEY_PLACEHOLDER;
const STRIPE_PRICE_ID = process.env.SILENTGPT_STRIPE_MONTHLY_PRICE_ID || STRIPE_PRICE_PLACEHOLDER;
const STRIPE_ANNUAL_PRICE_ID = process.env.SILENTGPT_STRIPE_ANNUAL_PRICE_ID || STRIPE_PRICE_PLACEHOLDER;
const STRIPE_SUCCESS_URL = process.env.SILENTGPT_STRIPE_SUCCESS_URL || 'https://trysilentgpt.net/checkout/success?session_id={CHECKOUT_SESSION_ID}';
const STRIPE_CANCEL_URL = process.env.SILENTGPT_STRIPE_CANCEL_URL || 'https://trysilentgpt.net/checkout/cancel';
const STRIPE_BILLING_PORTAL_RETURN_URL = process.env.SILENTGPT_STRIPE_BILLING_PORTAL_RETURN_URL || 'https://trysilentgpt.net/account';
const PREMIUM_PRICE_IDS = new Set([STRIPE_PRICE_ID, STRIPE_ANNUAL_PRICE_ID].filter(Boolean).filter(id => id !== STRIPE_PRICE_PLACEHOLDER));

// GitHub token for support tickets (Issues API) — use environment variables.
const GITHUB_SUPPORT_PLACEHOLDER = 'YOUR_GH' + '_SUPPORT_TOKEN';
const GITHUB_SUPPORT_TOKEN = process.env.SILENTGPT_GITHUB_SUPPORT_TOKEN || GITHUB_SUPPORT_PLACEHOLDER;
const GITHUB_REPO = 'Salt30/SilentGPT';

const STORE_DEFAULTS = {
  apiKey:        BUILT_IN_API_KEY,
  openaiKey:     OPENAI_API_KEY,
  apiEndpoint:   'https://api.openai.com/v1/chat/completions',
  model:         'gpt-5.4-mini',
  overlayOpacity: 0.0,
  accentColor:   '#2f4f4f',
  fontSize:      14,
  fontFamily:    'system-ui, -apple-system, sans-serif',
  borderRadius:  12,
  hotkey:          'Alt+3',
  hotkeyAnswer:    'Alt+1',
  hotkeyTranslate: 'Alt+2',
  hotkeyAutopilot: 'Alt+4',
  hotkeyDripType:  'Alt+5',
  hotkeyStopDrip:  'Alt+0',
  hotkeySimple:    'Alt+6',
  hotkeySolve:     'Alt+7',
  hotkeyEssay:     'Alt+8',
  hotkeyCode:      'Alt+9',
  hotkeyResearch:  'CmdOrCtrl+Alt+1',
  hotkeyEmail:     'CmdOrCtrl+Alt+2',
  hotkeyFlashcards:'CmdOrCtrl+Alt+3',
  hotkeyApp:       'Alt+M',
  language:      'Spanish',
  theme:         'dark',
  lastMode:      'answer',
  simpleMode:    false,
  phantomMode:   false,
  allowScreenCapture: false,
  autoEngine:    true,
  credibleSourcesOnly: false,
  maxTokens:     1024,
  dripSpeed:     40,
  dripWPM:       45,
  dripDelay:     10,
  typoRate:      0.03,
  dripPauseChance: 0.03,
  dripBurstChance: 0.08,
  invisibleOverlay: false,
  autopilotDelay:     800,
  autopilotDelayRandom: 500,
  autopilotHumanize:  true,
  autopilotScrollTo:  true,
  hotkeyInstant: 'CmdOrCtrl+Shift+A',
  hotkeySelfDestruct: 'CmdOrCtrl+Alt+Shift+Backspace',
  lockdownMode: false,
  ghostAnswer: false,
  clearScreen: false,
  aiContext: '',
  authDone: false,
  authName: '',
  authEmail: '',
  authPasswordHash: '',
  onboardingDone: false,
  licenseKey: '',
  licenseValid: false,
  licenseEmail: '',
  stripeCustomerId: '',
  stripeSubscriptionId: '',
  termsAccepted: false,
  subscriptionStatus: 'inactive',
  membershipTier: 'free',
  lastSubscriptionCheck: 0,
  trialStarted: 0,
  trialDays: 3,
  // Usage Analytics
  statsFirstLaunch: 0,
  statsTotalSessions: 0,
  statsAnswerCount: 0,
  statsSimpleCount: 0,
  statsTranslateCount: 0,
  statsRewriteCount: 0,
  statsDripTypeCount: 0,
  statsSummarizeCount: 0,
  statsExplainCount: 0,
  statsTotalRequests: 0,
  statsLastUsed: 0,
  // Support Tickets (local log)
  supportTickets: [],
  accountSignups: [],
  pendingSignupNotifications: []
};

let store = null;

function initStore() {
  if (store) return store;
  try {
    store = new Store({ name: 'silentgpt-config', defaults: STORE_DEFAULTS });
    // Test that the store is readable
    store.get('apiKey');
  } catch (_) {
    // Config file is corrupted — delete it and start fresh
    const fs = require('fs');
    try {
      const configPath = path.join(app.getPath('userData'), 'silentgpt-config.json');
      fs.unlinkSync(configPath);
    } catch (_) {}
    store = new Store({ name: 'silentgpt-config', defaults: STORE_DEFAULTS });
  }

  // If stored provider keys are placeholders, update them from the runtime environment.
  // This lets users drop a local .env file into the app folder without manually
  // editing the persisted Electron store created by an earlier launch.
  const savedKey = store.get('apiKey');
  if ((!savedKey || savedKey === API_PLACEHOLDER) && BUILT_IN_API_KEY !== API_PLACEHOLDER) {
    store.set('apiKey', BUILT_IN_API_KEY);
  }

  const savedOpenAIKey = store.get('openaiKey');
  if ((!savedOpenAIKey || savedOpenAIKey === OPENAI_KEY_PLACEHOLDER) && OPENAI_API_KEY !== OPENAI_KEY_PLACEHOLDER) {
    store.set('openaiKey', OPENAI_API_KEY);
  }

  // v3.15.1 migration: Rewrite mode removed — remap its hotkey to Autopilot
  if (store.get('hotkeyRewrite')) {
    const oldRewriteKey = store.get('hotkeyRewrite');
    // If autopilot has no hotkey or still has old default, give it rewrite's hotkey
    if (!store.get('hotkeyAutopilot') || store.get('hotkeyAutopilot') === 'CmdOrCtrl+Alt+4') {
      store.set('hotkeyAutopilot', oldRewriteKey);
    }
    store.delete('hotkeyRewrite');
  }

  return store;
}

/* ─────────────────── Stripe Client ─────────────────── */

let stripeClient = null;
function getStripe() {
  if (stripeClient) return stripeClient;
  if (!STRIPE_SECRET_KEY || STRIPE_SECRET_KEY === STRIPE_KEY_PLACEHOLDER) return null;
  const Stripe = require('stripe');
  stripeClient = new Stripe(STRIPE_SECRET_KEY, {
    appInfo: { name: 'SilentGPT', version: app.getVersion() }
  });
  return stripeClient;
}

function describeLoadedEnvFiles() {
  if (LOADED_ENV_FILES.length) return ` Loaded env file(s): ${LOADED_ENV_FILES.join(', ')}.`;
  const checkedFiles = getLocalEnvironmentCandidateFiles().join(', ');
  return ` No .env file was found. Checked: ${checkedFiles}.`;
}

function stripeConfigError(plan) {
  if (!STRIPE_SECRET_KEY || STRIPE_SECRET_KEY === STRIPE_KEY_PLACEHOLDER) {
    return `Stripe secret key is missing. Add SILENTGPT_STRIPE_SECRET_KEY to a local .env file or export it before launching SilentGPT.${describeLoadedEnvFiles()}`;
  }
  if (plan === 'annual' && (!STRIPE_ANNUAL_PRICE_ID || STRIPE_ANNUAL_PRICE_ID === STRIPE_PRICE_PLACEHOLDER)) {
    return 'Stripe annual price ID is missing. Set SILENTGPT_STRIPE_ANNUAL_PRICE_ID.';
  }
  if (plan !== 'annual' && (!STRIPE_PRICE_ID || STRIPE_PRICE_ID === STRIPE_PRICE_PLACEHOLDER)) {
    return 'Stripe monthly price ID is missing. Set SILENTGPT_STRIPE_MONTHLY_PRICE_ID.';
  }
  return null;
}

// Admin master keys — always valid
const ADMIN_KEYS = ['SILENTGPT-ADMIN-MASTER-2026', 'SilentGPTAdmin2026'];

/* ─────────────────── Usage Analytics ─────────────────── */

// SHA-256 hashes of admin emails — no plaintext PII in the binary
const crypto = require('crypto');
function sha256(s) { return crypto.createHash('sha256').update(s.toLowerCase().trim()).digest('hex'); }
const ADMIN_EMAIL_HASHES = [
  'c776d3f7d71b03630f43c47ce83ccab26d7f6a7c2a017b37f909e7f407776766'  // admin email hash
];

function isAdmin() {
  const key = store.get('licenseKey');
  const email = (store.get('authEmail') || store.get('licenseEmail') || '').toLowerCase().trim();
  return ADMIN_KEYS.includes(key) || (email && ADMIN_EMAIL_HASHES.includes(sha256(email)));
}

function trackUsage(mode) {
  const key = 'stats' + mode.charAt(0).toUpperCase() + mode.slice(1) + 'Count';
  store.set(key, (store.get(key) || 0) + 1);
  store.set('statsTotalRequests', (store.get('statsTotalRequests') || 0) + 1);
  store.set('statsLastUsed', Date.now());
}

function initAnalytics() {
  if (!store.get('statsFirstLaunch')) store.set('statsFirstLaunch', Date.now());
  store.set('statsTotalSessions', (store.get('statsTotalSessions') || 0) + 1);
}

/* ─────────────────── Lockdown Mode ─────────────────── */

function hasProAccess() {
  if (!store) initStore();
  if (isAdmin()) return true;
  return store.get('licenseValid') === true &&
    store.get('membershipTier') === 'premium' &&
    store.get('subscriptionStatus') === 'active' &&
    !!store.get('stripeSubscriptionId');
}

function isAppUnlocked() {
  if (!store) initStore();
  return hasProAccess() || store.get('termsAccepted') === true;
}

function isLockdown() {
  return !!(store && hasProAccess() && store.get('lockdownMode'));
}

/** In lockdown mode, re-assert overlay above everything on a fast timer */
let lockdownKeepAlive = null;

function startLockdownKeepAlive() {
  if (lockdownKeepAlive) return;
  // 100ms on BOTH platforms — SEB and Respondus aggressively fight for z-order
  const interval = 100;
  lockdownKeepAlive = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (!overlayUp) return;
    applyOverlayLevel();
    try { overlayWin.moveTop(); } catch (_) {}
    // Recovery: if the overlay got minimized or hidden externally, restore it
    try {
      if (overlayWin.isMinimized()) overlayWin.restore();
      if (!overlayWin.isVisible()) { overlayWin.showInactive(); enforceContentProtection(overlayWin); }
    } catch (_) {}
    // Toggle alwaysOnTop off/on to force OS to recalculate z-order (fights SEB/Respondus)
    try { overlayWin.setAlwaysOnTop(false); } catch (_) {}
    try { overlayWin.setAlwaysOnTop(true, 'screen-saver', 99); } catch (_) {}
  }, interval);
}

function stopLockdownKeepAlive() {
  if (lockdownKeepAlive) { clearInterval(lockdownKeepAlive); lockdownKeepAlive = null; }
}

/* ─────────────────── Kernel Shield (Windows) ─────────────────── */
// Ring-0 kernel driver for true process stealth — hides from Task Manager,
// blocks termination by lockdown browsers, and resists all user-mode detection.
// Falls back gracefully if driver not installed (all calls return false).

let kernelShield = null;

function resolveOptionalModule(basePath) {
  const candidates = [basePath, `${basePath}.js`, `${basePath}.json`, `${basePath}.node`];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getKernelShieldModulePath() {
  return resolveOptionalModule(path.join(__dirname, '..', 'kernel', 'windows', 'usermode', 'silentgpt_shield_node'));
}

function getKernelDriverLoaderPath() {
  return resolveOptionalModule(path.join(__dirname, '..', 'kernel', 'windows', 'driver_loader'));
}

function initKernelShield() {
  if (process.platform !== 'win32') return false;

  const shieldModulePath = getKernelShieldModulePath();
  if (!shieldModulePath) {
    kernelShield = null;
    return false;
  }

  try {
    kernelShield = require(shieldModulePath);
    if (kernelShield.available()) {
      console.log('[KERNEL] Shield driver detected — kernel-level stealth available');
      return true;
    }

    console.log('[KERNEL] Shield driver not loaded — using user-mode stealth only');
    kernelShield = null;
    return false;
  } catch (err) {
    console.warn('[KERNEL] Shield module failed to load; using user-mode stealth only.');
    kernelShield = null;
    return false;
  }
}

/** Activate kernel-level stealth (hide + protect process) */
function activateKernelStealth() {
  if (!kernelShield) return false;
  try {
    const result = kernelShield.stealthMode();
    if (result) {
      console.log('[KERNEL] Stealth mode ACTIVE — process hidden + protected');
    }
    return result;
  } catch (_) { return false; }
}

/** Deactivate kernel-level stealth */
function deactivateKernelStealth() {
  if (!kernelShield) return false;
  try {
    const result = kernelShield.stealthOff();
    if (result) {
      console.log('[KERNEL] Stealth mode OFF — process visible again');
    }
    return result;
  } catch (_) { return false; }
}

/** Clean shutdown of kernel driver handle */
function shutdownKernelShield() {
  if (!kernelShield) return;
  try {
    kernelShield.stealthOff();
    kernelShield.close();
    console.log('[KERNEL] Shield shut down cleanly');
  } catch (_) {}
  kernelShield = null;
}

/* ─────────────────── Window References ─────────────────── */

let overlayWin     = null;
let settingsWin    = null;
let flashcardsWin  = null;
let pinnedWin      = null;
let tray           = null;
let overlayUp      = false;

function fitWindowToPrimaryDisplay(width, height, options = {}) {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea || { x: 0, y: 0, width: display.size.width, height: display.size.height };
  const margin = options.margin ?? 32;
  const maxWidth = Math.max(320, workArea.width - margin);
  const maxHeight = Math.max(320, workArea.height - margin);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const fittedWidth = Math.floor(width * scale);
  const fittedHeight = Math.floor(height * scale);

  return {
    width: fittedWidth,
    height: fittedHeight,
    x: Math.round(workArea.x + (workArea.width - fittedWidth) / 2),
    y: Math.round(workArea.y + (workArea.height - fittedHeight) / 2)
  };
}

function fitMinimumSize(width, height, options = {}) {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea || { width: display.size.width, height: display.size.height };
  const margin = options.margin ?? 32;
  return {
    minWidth: Math.min(width, Math.max(320, workArea.width - margin)),
    minHeight: Math.min(height, Math.max(320, workArea.height - margin))
  };
}

/* ─────────────────── Screen Share Stealth ─────────────────── */

let screenBeingCaptured = false;
let screenCaptureSubId  = null;
let screenCapturePoll   = null;

function allowScreenCaptureVisibility() {
  if (!store) initStore();
  return !!store.get('allowScreenCapture');
}

function shouldProtectWindowFromCapture() {
  return !allowScreenCaptureVisibility();
}

function setWindowCaptureVisibility(win, protect) {
  if (!win || win.isDestroyed()) return;
  try { win.setContentProtection(!!protect); } catch (_) {}
}

function getCaptureProtectedWindows() {
  return [overlayWin, settingsWin, flashcardsWin, pinnedWin, activateWin, checkoutWin, authWin, welcomeWin]
    .filter((win) => win && !win.isDestroyed());
}

function refreshCaptureProtection() {
  const protect = shouldProtectWindowFromCapture();
  getCaptureProtectedWindows().forEach((win) => setWindowCaptureVisibility(win, protect));

  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (!protect || !screenBeingCaptured) {
    try { overlayWin.setOpacity(1); } catch (_) {}
    try { overlayWin.webContents.send('screen-share-status', false); } catch (_) {}
  } else if (screenBeingCaptured) {
    try { overlayWin.setOpacity(0); } catch (_) {}
    try { overlayWin.webContents.send('screen-share-status', true); } catch (_) {}
  }
}

/**
 * When screen recording/sharing is detected:
 *  - Set overlay window opacity to 0 (completely invisible in recordings)
 *  - Content protection makes it a black box, but opacity 0 makes even THAT invisible
 *  - The window remains active and functional — hotkeys, selections still work
 *  - Notify overlay renderer to show a tiny stealth indicator so user knows it's hidden
 *
 * When recording stops: restore full opacity
 */
function onScreenCaptureChanged(isCapturing) {
  screenBeingCaptured = isCapturing;
  if (!overlayWin || overlayWin.isDestroyed()) return;

  if (allowScreenCaptureVisibility()) {
    try { overlayWin.setOpacity(1); } catch (_) {}
    try { overlayWin.webContents.send('screen-share-status', false); } catch (_) {}
    return;
  }

  if (isCapturing) {
    // Make window completely invisible in screen capture
    try { overlayWin.setOpacity(0); } catch (_) {}
    // Notify renderer to show stealth indicator
    try { overlayWin.webContents.send('screen-share-status', true); } catch (_) {}
  } else {
    // Restore full visibility
    try { overlayWin.setOpacity(1); } catch (_) {}
    try { overlayWin.webContents.send('screen-share-status', false); } catch (_) {}
  }
}

function initScreenCaptureDetection() {
  if (process.platform === 'darwin') {
    // macOS: subscribe to system notification when screen capture state changes
    try {
      const { systemPreferences } = require('electron');
      screenCaptureSubId = systemPreferences.subscribeNotification(
        'com.apple.screenIsBeingCapturedDidChange',
        () => {
          // Query actual screen capture state via Python + CoreGraphics
          exec(
            `python3 -c "
import Quartz
session = Quartz.CGSessionCopyCurrentDictionary()
captured = session.get('kCGSSessionScreenIsBeingCaptured', 0) if session else 0
print('yes' if captured else 'no')
" 2>/dev/null`,
            { timeout: 3000 },
            (err, stdout) => {
              const capturing = stdout && stdout.trim() === 'yes';
              if (capturing !== screenBeingCaptured) {
                onScreenCaptureChanged(capturing);
              }
            }
          );
        }
      );

      // Also do an initial check on startup
      exec(
        `python3 -c "
import Quartz
session = Quartz.CGSessionCopyCurrentDictionary()
captured = session.get('kCGSSessionScreenIsBeingCaptured', 0) if session else 0
print('yes' if captured else 'no')
" 2>/dev/null`,
        { timeout: 3000 },
        (err, stdout) => {
          if (stdout && stdout.trim() === 'yes') onScreenCaptureChanged(true);
        }
      );
    } catch (_) {
      // Fallback: poll-based detection for older macOS
      startScreenCapturePoll();
    }
  } else if (process.platform === 'win32') {
    // Windows: poll for common screen recording processes
    startScreenCapturePoll();
  }
}

function startScreenCapturePoll() {
  if (screenCapturePoll) return;
  screenCapturePoll = setInterval(() => {
    if (process.platform === 'win32') {
      exec(
        `powershell -Command "Get-Process -Name obs64,obs32,ScreenClip,CamtasiaStudio -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Name }"`,
        { timeout: 3000 },
        (err, stdout) => {
          const capturing = !!(stdout && stdout.trim());
          if (capturing !== screenBeingCaptured) onScreenCaptureChanged(capturing);
        }
      );
    }
  }, 3000);
}

function cleanupScreenCaptureDetection() {
  if (screenCaptureSubId !== null && process.platform === 'darwin') {
    try {
      const { systemPreferences } = require('electron');
      systemPreferences.unsubscribeNotification(screenCaptureSubId);
    } catch (_) {}
    screenCaptureSubId = null;
  }
  if (screenCapturePoll) { clearInterval(screenCapturePoll); screenCapturePoll = null; }
}

/* ─────────────────── Overlay Window ─────────────────── */

/** Apply content protection — hides window from ALL screen capture/share/recording */
function enforceContentProtection(win) {
  setWindowCaptureVisibility(win, shouldProtectWindowFromCapture());
}

/** Re-apply window level + workspace visibility + content protection */
function applyOverlayLevel() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // 1. Content protection first
  enforceContentProtection(overlayWin);
  // 2. Visible on all workspaces INCLUDING fullscreen spaces
  try { overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  // 3. Highest window level — screen-saver renders above everything
  // In lockdown mode, use max relative level (99) to beat SEB/Respondus z-order
  const relLevel = isLockdown() ? 99 : 1;
  try { overlayWin.setAlwaysOnTop(true, 'screen-saver', relLevel); } catch (_) { overlayWin.setAlwaysOnTop(true); }
  if (process.platform === 'darwin') {
    try { overlayWin.setWindowButtonVisibility(false); } catch (_) {}
  }
  // 4. On Windows, moveTop() forces window to top of z-order (fights lockdown browsers)
  if (process.platform === 'win32') {
    try { overlayWin.moveTop(); } catch (_) {}
  }
  // 4. If screen is being captured and privacy protection is enabled, keep opacity at 0
  if (screenBeingCaptured && shouldProtectWindowFromCapture()) {
    try { overlayWin.setOpacity(0); } catch (_) {}
  } else {
    try { overlayWin.setOpacity(1); } catch (_) {}
  }
}

function makeOverlay() {
  if (!store) initStore();
  const display = screen.getPrimaryDisplay();
  const bounds = display.bounds || { x: 0, y: 0, width: display.size.width, height: display.size.height };

  const winOpts = {
    x: bounds.x, y: bounds.y,
    width:  bounds.width,
    height: bounds.height,
    transparent:      true,
    frame:            false,
    alwaysOnTop:      true,
    skipTaskbar:      true,
    resizable:        false,
    movable:          false,
    fullscreenable:   false,
    hasShadow:        false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  };

  // Panel type on macOS — NSPanel can join fullscreen Spaces natively
  if (process.platform === 'darwin') winOpts.type = 'panel';

  overlayWin = new BrowserWindow(winOpts);
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));

  // Apply content protection immediately
  enforceContentProtection(overlayWin);

  // Re-apply content protection on EVERY visibility change
  // macOS can reset sharingType when panel windows change state
  overlayWin.on('show', () => {
    enforceContentProtection(overlayWin);
    // Double-apply after a short delay to catch any macOS resets
    setTimeout(() => enforceContentProtection(overlayWin), 50);
    setTimeout(() => enforceContentProtection(overlayWin), 200);
  });
  overlayWin.on('focus', () => enforceContentProtection(overlayWin));
  overlayWin.on('blur', () => enforceContentProtection(overlayWin));
  overlayWin.webContents.on('did-finish-load', () => enforceContentProtection(overlayWin));

  applyOverlayLevel();
  applyCloseResistance(overlayWin); // Resist external close attempts on Windows

  overlayWin.setIgnoreMouseEvents(false);
  overlayWin.hide();

  overlayWin.on('closed', () => { overlayWin = null; });
}

/* ─────────────────── Settings Window ─────────────────── */

function makeSettings() {
  // Guard: if settings window already exists and isn't destroyed, show/focus it.
  // The Alt+M app hotkey can hide the main menu, so makeSettings must restore a
  // hidden existing window instead of only focusing it.
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (!settingsWin.isVisible()) settingsWin.show();
    settingsWin.focus();
    return;
  }
  // Clean up stale reference
  settingsWin = null;

  const bounds = fitWindowToPrimaryDisplay(700, 900, { margin: 24 });
  const minSize = fitMinimumSize(700, 900, { margin: 24 });
  settingsWin = new BrowserWindow({
    ...bounds,
    ...minSize,
    ...framelessWindowOptions(),
    frame: false, resizable: true, minimizable: true, maximizable: false,
    title: 'SilentGPT Settings',
    backgroundColor: '#020403',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });

  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  enforceContentProtection(settingsWin);
  settingsWin.on('closed', () => { settingsWin = null; });
}

function toggleSettings() {
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()) {
    settingsWin.hide();
    return;
  }
  makeSettings();
}

function showMainMenuIfReady() {
  if (store.get('authDone') && store.get('onboardingDone') && isAppUnlocked()) {
    makeSettings();
  }
}

/* ─────────────────── Flashcards Window ─────────────────── */

function showFlashcards(cardsText) {
  if (flashcardsWin) { flashcardsWin.focus(); return; }
  if (process.platform === 'darwin') app.dock?.show();

  const bounds = fitWindowToPrimaryDisplay(1024, 768);
  const minSize = fitMinimumSize(640, 480);
  flashcardsWin = new BrowserWindow({
    ...bounds,
    ...minSize,
    ...framelessWindowOptions(),
    resizable: true, minimizable: true, maximizable: true,
    fullscreenable: true,
    title: 'SilentGPT Flashcards',
    backgroundColor: '#020403',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });

  flashcardsWin.loadFile(path.join(__dirname, 'flashcards.html'));
  enforceContentProtection(flashcardsWin);
  flashcardsWin.webContents.on('did-finish-load', () => {
    flashcardsWin.webContents.send('load-cards', cardsText || '');
  });
  flashcardsWin.once('ready-to-show', () => { flashcardsWin.show(); flashcardsWin.focus(); });
  flashcardsWin.on('closed', () => {
    flashcardsWin = null;
    if (process.platform === 'darwin' && isAppUnlocked()) app.dock?.hide();
  });
}

/* ─────────────────── Screen Capture ─────────────────── */

/**
 * Native OS-level screen capture — bypasses Electron's desktopCapturer entirely.
 * Works through Safe Exam Browser, Respondus, and other lockdown browsers that
 * hook/block Chromium's capture API but can't block OS-level tools.
 * Uses screencapture (macOS) and GDI+ via PowerShell (Windows).
 */
async function grabScreenNative() {
  if (process.platform === 'darwin') {
    try {
      const tmpFile = path.join(os.tmpdir(), 'silentgpt_nat_' + Date.now() + '.png');
      await new Promise((resolve, reject) => {
        exec(`screencapture -x "${tmpFile}"`, { timeout: 8000 }, (err) => err ? reject(err) : resolve());
      });
      if (!fs.existsSync(tmpFile)) return null;
      const imgBuf = fs.readFileSync(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (imgBuf.length < 500) return null; // Too small = failed capture
      return 'data:image/png;base64,' + imgBuf.toString('base64');
    } catch (_) {}
  }

  if (process.platform === 'win32') {
    try {
      const tmpFile = path.join(os.tmpdir(), 'silentgpt_nat_' + Date.now() + '.png');
      const ps = `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); $bmp.Save('${tmpFile.replace(/\\/g, '\\\\')}'); $g.Dispose(); $bmp.Dispose()`;
      await new Promise((resolve, reject) => {
        exec(`powershell -WindowStyle Hidden -Command "${ps}"`, { timeout: 8000, windowsHide: true }, (err) => err ? reject(err) : resolve());
      });
      if (!fs.existsSync(tmpFile)) return null;
      const imgBuf = fs.readFileSync(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (imgBuf.length < 500) return null;
      return 'data:image/png;base64,' + imgBuf.toString('base64');
    } catch (_) {}
  }

  return null;
}

async function grabScreen() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scale = display.scaleFactor || 2;
  // A real full-screen capture should produce a data URL of at least 50KB
  // Smaller images are likely blank/corrupt (lockdown browser blocked the capture)
  const MIN_VALID_SIZE = 50000;

  // Step 1: Try Electron desktopCapturer (fastest, but lockdown browsers can block it)
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
    });
    if (sources && sources.length > 0) {
      const displayId = String(display.id || '');
      const aspect = width / height;
      const source = sources.find(src => String(src.display_id || '') === displayId)
        || sources.find(src => {
          const size = src.thumbnail.getSize();
          return size && size.height && Math.abs((size.width / size.height) - aspect) < 0.03;
        })
        || sources[0];
      const img = source.thumbnail.toDataURL();
      if (img && img.length > MIN_VALID_SIZE) return img; // Good capture
      // If image is too small, desktopCapturer probably returned blank/black — fall through
      console.log(`[CAPTURE] desktopCapturer returned small image (${img ? img.length : 0} chars) for ${source.name || 'screen'} — trying native capture`);
    }
  } catch (_) {}

  // Step 2: Try native OS-level capture (bypasses Chromium hooks from lockdown browsers)
  try {
    const nativeImg = await grabScreenNative();
    if (nativeImg && nativeImg.length > MIN_VALID_SIZE) return nativeImg;
    if (nativeImg) console.log(`[CAPTURE] Native capture returned small image (${nativeImg.length} chars)`);
  } catch (_) {}

  // Step 3: Last-resort fallbacks with lower validation threshold
  if (process.platform === 'win32') {
    try {
      const tmpFile = path.join(os.tmpdir(), 'silentgpt_cap_' + Date.now() + '.png');
      const ps = `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); $bmp.Save('${tmpFile.replace(/\\/g, '\\\\')}'); $g.Dispose(); $bmp.Dispose()`;
      await new Promise((resolve, reject) => {
        exec(`powershell -WindowStyle Hidden -Command "${ps}"`, { timeout: 8000, windowsHide: true }, (err) => err ? reject(err) : resolve());
      });
      if (fs.existsSync(tmpFile)) {
        const imgBuf = fs.readFileSync(tmpFile);
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        if (imgBuf.length > 500) return 'data:image/png;base64,' + imgBuf.toString('base64');
      }
    } catch (_) {}
  }

  if (process.platform === 'darwin') {
    try {
      const tmpFile = path.join(os.tmpdir(), 'silentgpt_cap_' + Date.now() + '.png');
      await new Promise((resolve, reject) => {
        exec(`screencapture -x "${tmpFile}"`, { timeout: 8000 }, (err) => err ? reject(err) : resolve());
      });
      if (fs.existsSync(tmpFile)) {
        const imgBuf = fs.readFileSync(tmpFile);
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        if (imgBuf.length > 500) return 'data:image/png;base64,' + imgBuf.toString('base64');
      }
    } catch (_) {}
  }

  return null;
}

/* ─────────────────── Show / Toggle Overlay ─────────────────── */

function showWithMode(mode) {
  // Block overlay until the user has chosen Lite or Pro.
  if (!isAppUnlocked()) { showActivate(); return; }
  if (!overlayWin) makeOverlay();

  if (mode === 'research') mode = 'interview';

  const wasOverlayVisible = overlayUp && overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible();

  const finishShow = (img) => {
    if (!overlayWin) return;
    overlayWin.setIgnoreMouseEvents(false);  // ensure drag works on fresh show
    applyOverlayLevel();               // re-assert level before every show
    overlayWin.webContents.send('set-mode', mode);
    overlayWin.webContents.send('screen-captured', img);
    overlayWin.webContents.send('load-settings', sanitizedSettings());
    overlayWin.showInactive();
    // Re-enforce content protection AFTER show — critical for panel windows
    enforceContentProtection(overlayWin);
    overlayUp = true;
    // In lockdown mode, start the keep-alive timer to stay above lockdown browsers
    if (isLockdown()) startLockdownKeepAlive();
  };

  if (mode === 'interview') {
    finishShow(null);
    return;
  }

  // In lockdown mode, use native OS capture (bypasses lockdown browser's Chromium hooks)
  // Safe Exam Browser / Respondus block desktopCapturer but can't block screencapture/GDI+
  if (isLockdown()) {
    // Use opacity trick: make overlay invisible without hiding it (SEB may block re-show)
    try { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setOpacity(0); } catch (_) {}
    setTimeout(async () => {
      let img = null;
      try { img = await grabScreenNative(); } catch (_) {}
      // If native capture failed or returned tiny image, try full grabScreen pipeline
      if (!img || img.length < 50000) {
        try { img = await grabScreen(); } catch (_) {}
      }
      try { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setOpacity(1); } catch (_) {}
      finishShow(img); // img may be null if all capture methods fail — falls back to type-only
    }, 300);
    return;
  }

  // Normal mode: hide any existing overlay before capture so Alt+1 never reuses
  // the previous screenshot or captures the answer panel itself.
  if (wasOverlayVisible) {
    try { overlayWin.hide(); } catch (_) {}
    overlayUp = false;
    stopLockdownKeepAlive();
  }
  setTimeout(() => {
    grabScreen().then(img => finishShow(img)).catch(() => finishShow(null));
  }, wasOverlayVisible ? 180 : 0);
}

// Instant Answer: capture full screen → show overlay → auto-send to AI (no drag needed)
function instantAnswer() {
  if (!isAppUnlocked()) { showActivate(); return; }
  if (!overlayWin) makeOverlay();

  const finishInstant = (img) => {
    if (!overlayWin) return;
    applyOverlayLevel();
    overlayWin.webContents.send('set-mode', 'answer');
    overlayWin.webContents.send('screen-captured', img);
    overlayWin.webContents.send('load-settings', sanitizedSettings());
    overlayWin.showInactive();
    enforceContentProtection(overlayWin);
    overlayUp = true;
    if (isLockdown()) startLockdownKeepAlive();
    // Trigger instant processing after a short delay for the renderer to receive the capture
    setTimeout(() => {
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('instant-answer');
      }
    }, 400);
  };

  if (isLockdown()) {
    try { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setOpacity(0); } catch (_) {}
    setTimeout(async () => {
      let img = null;
      try { img = await grabScreenNative(); } catch (_) {}
      if (!img || img.length < 50000) { try { img = await grabScreen(); } catch (_) {} }
      try { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setOpacity(1); } catch (_) {}
      finishInstant(img);
    }, 300);
    return;
  }

  grabScreen().then(img => finishInstant(img)).catch(() => finishInstant(null));
}

function toggle() {
  // Block overlay until the user has chosen Lite or Pro.
  if (!isAppUnlocked()) { showActivate(); return; }
  if (!overlayWin) makeOverlay();
  if (overlayUp) { overlayWin.hide(); overlayUp = false; stopLockdownKeepAlive(); }
  else showWithMode(store.get('lastMode') || 'answer');
}

/* ─────────────────── Tray Icon ─────────────────── */

function makeTray() {
  let trayImage = getAppIconImage(16);
  if (trayImage.isEmpty()) trayImage = nativeImage.createFromPath(APP_TRAY_ICON_PATH);

  tray = new Tray(trayImage);

  const licensed = isAppUnlocked();
  const menu = Menu.buildFromTemplate([
    { label: 'Toggle Overlay', accelerator: store.get('hotkey'), click: toggle, enabled: licensed },
    { type: 'separator' },
    { label: 'Answer Mode',    click: () => showWithMode('answer'),    enabled: licensed },
    { label: 'Simple Mode',    click: () => showWithMode('simple'),    enabled: licensed },
    { label: 'Translate Mode',  click: () => showWithMode('translate'),  enabled: licensed },
    { label: 'Autopilot Mode',  click: () => showWithMode('autopilot'), enabled: licensed },
    { label: 'Drip Type Mode',  click: () => showWithMode('driptype'),  enabled: licensed },
    { type: 'separator' },
    ...(licensed ? [] : [{ label: 'Choose Lite or Pro', click: showActivate }, { type: 'separator' }]),
    { label: 'Interview Mode', click: () => showWithMode('interview'), enabled: licensed },
    { label: 'Settings', click: makeSettings },
    { type: 'separator' },
    { label: hasProAccess() ? 'Pro Stealth Features Available' : 'Pro unlocks stealth features', enabled: false },
    { type: 'separator' },
    { label: 'Quit SilentGPT', click: () => app.quit() }
  ]);

  tray.setToolTip('SilentGPT — AI Screen Overlay');
  tray.setContextMenu(menu);
  tray.on('click', toggle);
}

/* ─────────────────── Global Hotkeys ─────────────────── */

function bindKeys() {
  globalShortcut.unregisterAll();
  // App/settings hotkeys always work
  const appKeys = [
    [store.get('hotkeyApp'), toggleSettings]
  ];
  for (const [key, fn] of appKeys) {
    if (!key) continue;
    try { globalShortcut.register(key, fn); } catch (_) {}
  }
  // Overlay/feature hotkeys work for free Lite and paid Pro users.
  if (!isAppUnlocked()) return;

  // In lockdown mode, register BOTH normal hotkeys AND stealth hotkeys
  // Stealth hotkeys use F-key combos that lockdown browsers are less likely to intercept
  const featureKeys = [
    [store.get('hotkey'),          toggle],
    [store.get('hotkeyAnswer'),    () => showWithMode('answer')],
    [store.get('hotkeySimple'),    () => showWithMode('simple')],
    [store.get('hotkeyTranslate'), () => showWithMode('translate')],
    [store.get('hotkeyDripType'),  () => showWithMode('driptype')],
    [store.get('hotkeySolve'),     () => showWithMode('solve')],
    [store.get('hotkeyEssay'),     () => showWithMode('essay')],
    [store.get('hotkeyCode'),      () => showWithMode('code')],
    [store.get('hotkeyResearch'),  () => showWithMode('interview')],
    [store.get('hotkeyEmail'),     () => showWithMode('email')],
    [store.get('hotkeyFlashcards'),() => showWithMode('flashcards')],
    [store.get('hotkeyAutopilot'), () => showWithMode('autopilot')],
    [store.get('hotkeyStopDrip'),  () => { dripTypeCancelled = true; }],
    [store.get('hotkeyInstant'),   instantAnswer],
    [store.get('hotkeySelfDestruct'), selfDestructTrigger]
  ];
  for (const [key, fn] of featureKeys) {
    if (!key) continue;
    try { globalShortcut.register(key, fn); } catch (_) {}
  }

  // Stealth hotkeys for lockdown mode — letter-based combos that work without Fn key
  if (isLockdown()) {
    const stealthKeys = [
      ['Control+Shift+Z',  toggle],
      ['Control+Shift+A',  () => showWithMode('answer')],
      ['Control+Shift+S',  () => showWithMode('simple')],
      ['Control+Shift+T',  () => showWithMode('translate')],
      ['Control+Shift+D',  () => showWithMode('driptype')],
      ['Control+Shift+V',  () => showWithMode('solve')],
      ['Control+Shift+E',  () => showWithMode('essay')],
      ['Control+Shift+C',  () => showWithMode('code')],
      ['Control+Shift+F',  () => showWithMode('interview')],
      ['Control+Shift+W',  () => showWithMode('email')],
      ['Control+Shift+Q',  () => showWithMode('flashcards')],
      ['Control+Shift+P',  () => showWithMode('autopilot')],
      ['Control+Shift+X',  () => { dripTypeCancelled = true; }],
      ['Control+Alt+Shift+Backspace', selfDestructTrigger]
    ];
    for (const [key, fn] of stealthKeys) {
      try { globalShortcut.register(key, fn); } catch (_) {}
    }
  }
}

/* ─────────────────── Drip Type Engine ─────────────────── */

let dripTypeCancelled = false;
let dripTypeRunning = false;

const NEARBY = {
  a:'sqwz', b:'vngh', c:'xvdf', d:'sfcxer', e:'wrsd', f:'dgcvrt',
  g:'fhvbty', h:'gjbnyu', i:'ujko', j:'hknmui', k:'jlmio', l:'kop',
  m:'njk', n:'bmhj', o:'iklp', p:'ol', q:'wa', r:'edft', s:'awdxze',
  t:'rfgy', u:'yhji', v:'cbfg', w:'qase', x:'zsdc', y:'tghu', z:'xsa',
  '1':'2q','2':'13qw','3':'24we','4':'35er','5':'46rt',
  '6':'57ty','7':'68yu','8':'79ui','9':'80io','0':'9p'
};

function typoChar(ch) {
  const pool = NEARBY[ch.toLowerCase()];
  if (!pool) return ch;
  const t = pool[Math.floor(Math.random() * pool.length)];
  return ch === ch.toUpperCase() ? t.toUpperCase() : t;
}

function humanMs(base) {
  const g = () => { let u=0,v=0; while(!u)u=Math.random(); while(!v)v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
  let d = base + g() * base * 0.6;
  if (Math.random() < 0.02) d += 200 + Math.random() * 400;
  return Math.max(15, Math.round(d));
}

function escAS(c) {
  if (c === '"') return '\\"';
  if (c === '\\') return '\\\\';
  // Characters that can't be typed via keystroke — skip them
  if (c.charCodeAt(0) > 127) return c;
  return c;
}

ipcMain.on('cancel-drip-type', () => { dripTypeCancelled = true; });

// Strip markdown so drip-typed text reads like natural human writing
function cleanMarkdown(t) {
  if (!t) return t;
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/\*{1,3}([^*]+?)\*{1,3}/g, '$1');
  t = t.replace(/_{1,3}([^_]+?)_{1,3}/g, '$1');
  t = t.replace(/~~([^~]+?)~~/g, '$1');
  t = t.replace(/`([^`]+?)`/g, '$1');
  t = t.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, '').replace(/```/g, ''));
  t = t.replace(/^[\s]*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+\.\s+/gm, '');
  t = t.replace(/^>\s?/gm, '');
  t = t.replace(/^[-*_]{3,}\s*$/gm, '');
  t = t.replace(/\[([^\]]+?)\]\([^)]+?\)/g, '$1');
  t = t.replace(/!\[([^\]]*?)\]\([^)]+?\)/g, '$1');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

ipcMain.handle('drip-type', async (_ev, text) => {
  // Hide overlay FIRST — before any early return — so the selection/drag feature cannot activate
  if (overlayWin) { overlayWin.hide(); overlayUp = false; }
  if (!isAppUnlocked()) return { error: 'Choose Lite or Pro to use SilentGPT.' };
  if (!text) return { error: 'No text provided.' };
  text = cleanMarkdown(text);
  trackUsage('dripType');

  dripTypeCancelled = false;
  dripTypeRunning = true;

  // Configurable delay before typing starts (default 10 seconds)
  const delaySec = store.get('dripDelay') || 10;
  // Check cancel during delay (check every 500ms)
  for (let waited = 0; waited < delaySec * 1000; waited += 500) {
    if (dripTypeCancelled) { dripTypeRunning = false; return { cancelled: true }; }
    await new Promise(r => setTimeout(r, 500));
  }

  // Convert WPM to ms per character (avg word = 5 chars)
  const wpm = store.get('dripWPM') || 45;
  const speed = Math.round(60000 / (wpm * 5));
  const rate  = store.get('typoRate')  || 0.06;
  const pauseChance = store.get('dripPauseChance') || 0.03;
  const burstChance = store.get('dripBurstChance') || 0.08;

  if (process.platform === 'darwin') {
    const cmds = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      // Human-like thinking pause (random mid-sentence pause)
      if (Math.random() < pauseChance && i > 0) {
        cmds.push(`delay ${(1.0 + Math.random() * 2.5).toFixed(4)}`);
      }

      // Burst typing (briefly speed up like typing a familiar word)
      let charSpeed = speed;
      if (Math.random() < burstChance) charSpeed = speed * 0.5;

      const ms = humanMs(charSpeed) / 1000;

      if (/[a-zA-Z]/.test(ch) && Math.random() < rate) {
        // Type wrong character, pause (realize mistake), backspace, type correct
        const wrong = typoChar(ch);
        cmds.push(`keystroke "${escAS(wrong)}"`);
        // Longer pause to "notice" the typo
        cmds.push(`delay ${(0.3 + Math.random() * 0.5).toFixed(4)}`);
        // Delete the wrong character
        cmds.push('key code 51');
        cmds.push(`delay ${(0.08 + Math.random() * 0.12).toFixed(4)}`);
        // FORCE a second backspace to be safe (sometimes first one doesn't register)
        // Only add if the wrong char was actually different
        if (wrong !== ch) {
          // Small verification delay then type correct char
          cmds.push(`delay ${(0.05 + Math.random() * 0.1).toFixed(4)}`);
        }
        cmds.push(`keystroke "${escAS(ch)}"`);
        cmds.push(`delay ${ms.toFixed(4)}`);
      } else if (ch === '\n') {
        cmds.push('key code 36');
        cmds.push(`delay ${(ms + 0.3 + Math.random() * 0.5).toFixed(4)}`);
      } else if (ch === '\t') {
        cmds.push('key code 48');
        cmds.push(`delay ${ms.toFixed(4)}`);
      } else if ('.!?'.includes(ch)) {
        // End of sentence — longer pause
        cmds.push(`keystroke "${escAS(ch)}"`);
        cmds.push(`delay ${(ms + 0.4 + Math.random() * 0.8).toFixed(4)}`);
      } else if (ch === ',') {
        // Comma — slight pause
        cmds.push(`keystroke "${escAS(ch)}"`);
        cmds.push(`delay ${(ms + 0.1 + Math.random() * 0.3).toFixed(4)}`);
      } else {
        cmds.push(`keystroke "${escAS(ch)}"`);
        cmds.push(`delay ${ms.toFixed(4)}`);
      }
    }

    const CHUNK = 150;
    for (let c = 0; c < cmds.length; c += CHUNK) {
      if (dripTypeCancelled) { dripTypeRunning = false; return { cancelled: true }; }
      const script = `tell application "System Events"\n${cmds.slice(c, c + CHUNK).join('\n')}\nend tell`;
      // Write to temp file to avoid shell escaping issues (single quotes, backslashes, etc.)
      const tmpPath = path.join(os.tmpdir(), 'silentgpt_drip_' + c + '.scpt');
      fs.writeFileSync(tmpPath, script);
      await new Promise(resolve => {
        exec(`osascript "${tmpPath}"`, { timeout: 120000 }, () => {
          try { fs.unlinkSync(tmpPath); } catch (_) {}
          resolve();
        });
      });
    }
    dripTypeRunning = false;
  } else {
    clipboard.writeText(text);
    return { fallback: true, message: 'Text copied to clipboard. Paste with Ctrl+V.' };
  }
});

/* ─────────────────── IPC Handlers ─────────────────── */

// Clipboard write — uses Electron clipboard + native OS fallback
// Lockdown browsers may hook the clipboard at browser level; this bypasses that
// Click-through: let user interact with exam below the overlay
ipcMain.on('set-ignore-mouse', (_ev, ignore, opts) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try { overlayWin.setIgnoreMouseEvents(ignore, opts || {}); } catch (_) {}
});

ipcMain.on('copy-to-clipboard', (_ev, text) => {
  // Electron's main process clipboard
  try { clipboard.writeText(text); } catch (_) {}
  // Native OS fallback — writes directly via shell (bypasses any API hooks)
  if (process.platform === 'darwin') {
    try {
      const proc = require('child_process').spawn('pbcopy');
      proc.stdin.write(text);
      proc.stdin.end();
    } catch (_) {}
  } else if (process.platform === 'win32') {
    try {
      const proc = require('child_process').spawn('clip');
      proc.stdin.write(text);
      proc.stdin.end();
    } catch (_) {}
  }
});

ipcMain.on('hide-overlay', () => {
  if (overlayWin) { overlayWin.hide(); overlayUp = false; stopLockdownKeepAlive(); }
  // Also cancel drip type if running
  if (dripTypeRunning) dripTypeCancelled = true;
});

ipcMain.on('open-flashcards', (_ev, cards) => showFlashcards(cards));

ipcMain.handle('paste-to-screen', async () => {
  // Hide overlay first so the target app gets focus
  if (overlayWin) { overlayWin.hide(); overlayUp = false; stopLockdownKeepAlive(); }
  // Small delay to let the previous app regain focus
  await new Promise(r => setTimeout(r, 150));
  // Simulate Cmd+V (macOS) or Ctrl+V (Windows) to paste clipboard contents
  if (process.platform === 'darwin') {
    return new Promise(resolve => {
      exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, { timeout: 5000 }, (err) => {
        resolve({ success: !err });
      });
    });
  } else {
    return new Promise(resolve => {
      exec(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"`, { timeout: 5000 }, (err) => {
        resolve({ success: !err });
      });
    });
  }
});

/* ─────────────────── Autopilot Execution ─────────────────── */

function execPromise(cmd, timeout) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeout || 5000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─── Browser JS Injection (Primary method for web quizzes) ─── */
// Instead of synthesizing mouse clicks (which macOS blocks/ignores for Electron apps),
// we tell the browser to execute JavaScript that finds and clicks the answer element.
// This uses the same AppleScript Accessibility framework as Drip Type (confirmed working).

const BROWSER_NAMES = ['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Arc', 'Brave Browser', 'Microsoft Edge', 'Safari', 'Opera', 'Vivaldi', 'Firefox'];

async function detectFrontBrowser() {
  try {
    const name = (await execPromise(`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`, 3000)).trim();
    console.log('[Autopilot] Frontmost app:', name);
    if (BROWSER_NAMES.some(b => name.toLowerCase().includes(b.toLowerCase().split(' ')[0]))) return name;
    // Not a browser — check visible browser processes
    for (const b of BROWSER_NAMES) {
      try {
        const r = await execPromise(`osascript -e 'tell application "System Events" to get (count of (every process whose name is "${b}" and visible is true))'`, 2000);
        if (parseInt(r.trim()) > 0) return b;
      } catch(_) {}
    }
  } catch(_) {}
  return null;
}

async function browserExecJS(browserName, js) {
  const fs = require('fs');
  const os = require('os');

  // Write JS to a temp file, then have AppleScript read it — avoids all escaping issues
  const jsPath = path.join(os.tmpdir(), 'silentgpt_inject.js');
  fs.writeFileSync(jsPath, js);

  if (browserName === 'Safari') {
    const script = `set jsFile to POSIX file "${jsPath}"
set jsCode to read jsFile as «class utf8»
tell application "Safari"
  do JavaScript jsCode in document 1
end tell`;
    const p = path.join(os.tmpdir(), 'silentgpt_js.applescript');
    fs.writeFileSync(p, script);
    return await execPromise(`osascript "${p}" 2>&1`, 10000);
  } else {
    // Chrome, Arc, Brave, Edge — use "execute active tab of front window javascript"
    const script = `set jsFile to POSIX file "${jsPath}"
set jsCode to read jsFile as «class utf8»
tell application "${browserName}"
  execute active tab of front window javascript jsCode
end tell`;
    const p = path.join(os.tmpdir(), 'silentgpt_js.applescript');
    fs.writeFileSync(p, script);
    return await execPromise(`osascript "${p}" 2>&1`, 10000);
  }
}

// Click an answer in a browser by injecting JS to find and click matching elements
async function browserClickAnswer(browserName, field) {
  // JSON-encode answer and label to safely embed in JS without escaping issues
  const answerJSON = JSON.stringify(field.answer || '');
  const labelJSON = JSON.stringify(field.label || '');

  if (field.type === 'radio' || field.type === 'checkbox') {
    const js = `(function(){
      var answer = ${answerJSON}.trim().toLowerCase();
      var label = ${labelJSON}.trim().toLowerCase();

      // ── Helper: normalize text (collapse whitespace, strip special chars for comparison) ──
      function norm(s) { return (s||'').replace(/\\s+/g,' ').trim().toLowerCase(); }
      function normLoose(s) { return norm(s).replace(/[^a-z0-9.()=+\\-\\/]/g, ''); }

      // ── Helper: find the question container for a given label ──
      function findQuestionBlock(lbl) {
        // Google Forms: each question is in a div with [data-params] or a listitem role
        var blocks = document.querySelectorAll('[role="listitem"], .freebirdFormviewerViewNumberedItemContainer, [data-params]');
        for (var i = 0; i < blocks.length; i++) {
          var blockText = norm(blocks[i].textContent);
          if (blockText.includes(lbl.substring(0, Math.min(40, lbl.length)).toLowerCase())) return blocks[i];
        }
        return null;
      }

      var questionBlock = label ? findQuestionBlock(label) : null;
      var searchScope = questionBlock || document;

      // ══════ STRATEGY 1: Google Forms — div[role="radio"] or div[role="checkbox"] with data-value ══════
      var gRadios = searchScope.querySelectorAll('[role="radio"], [role="checkbox"], [data-value]');
      for (var i = 0; i < gRadios.length; i++) {
        var el = gRadios[i];
        var dv = el.getAttribute('data-value') || '';
        var ariaLabel = el.getAttribute('aria-label') || '';
        var elText = norm(el.textContent);
        if (norm(dv) === answer || norm(ariaLabel) === answer || elText === answer) {
          el.click(); return 'gform_exact_' + i;
        }
      }
      // Partial match on Google Forms elements
      for (var i = 0; i < gRadios.length; i++) {
        var el = gRadios[i];
        var dv = norm(el.getAttribute('data-value') || '');
        var ariaLabel = norm(el.getAttribute('aria-label') || '');
        var elText = norm(el.textContent);
        if (dv.includes(answer) || answer.includes(dv) || ariaLabel.includes(answer) || answer.includes(ariaLabel) || elText.includes(answer) || answer.includes(elText)) {
          el.click(); return 'gform_partial_' + i;
        }
      }
      // Loose match (strip special chars — catches math like N(t) = 500 · 2^(t/3))
      for (var i = 0; i < gRadios.length; i++) {
        var el = gRadios[i];
        var dv = normLoose(el.getAttribute('data-value') || '');
        var elText = normLoose(el.textContent);
        var answerLoose = normLoose(answer);
        if (answerLoose && (dv === answerLoose || elText === answerLoose || dv.includes(answerLoose) || answerLoose.includes(dv) || elText.includes(answerLoose) || answerLoose.includes(elText))) {
          el.click(); return 'gform_loose_' + i;
        }
      }

      // ══════ STRATEGY 2: Standard HTML radio/checkbox inputs ══════
      var inputs = searchScope.querySelectorAll('input[type=radio], input[type=checkbox]');
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        if (el.value && norm(el.value) === answer) {
          el.click(); el.checked = true; el.dispatchEvent(new Event('change', {bubbles:true}));
          return 'input_value_' + i;
        }
        var parent = el.closest('label') || el.parentElement;
        var parentText = parent ? norm(parent.textContent) : '';
        if (parentText === answer || parentText.includes(answer)) {
          el.click(); el.checked = true; el.dispatchEvent(new Event('change', {bubbles:true}));
          return 'input_parent_' + i;
        }
        if (el.id) {
          var assocLabel = document.querySelector('label[for="' + el.id + '"]');
          if (assocLabel && norm(assocLabel.textContent).includes(answer)) {
            el.click(); el.checked = true; el.dispatchEvent(new Event('change', {bubbles:true}));
            return 'input_label_' + i;
          }
        }
      }

      // ══════ STRATEGY 3: Text match on any clickable element ══════
      var elems = searchScope.querySelectorAll('label, span, div, li, p, a, button, td, th, option');
      // Exact match first
      for (var j = 0; j < elems.length; j++) {
        var txt = norm(elems[j].textContent);
        // Only match leaf-ish elements (not giant containers)
        if (txt.length > answer.length * 4) continue;
        if (txt === answer) {
          elems[j].click();
          var inp = elems[j].querySelector('input[type=radio], input[type=checkbox]');
          if (inp) { inp.click(); inp.checked = true; inp.dispatchEvent(new Event('change', {bubbles:true})); }
          return 'text_exact_' + j;
        }
      }
      // Partial / contains match
      for (var k = 0; k < elems.length; k++) {
        var t = norm(elems[k].textContent);
        if (t.length > answer.length * 4) continue;
        if (t.includes(answer) || answer.includes(t)) {
          elems[k].click();
          var inp2 = elems[k].querySelector('input[type=radio], input[type=checkbox]');
          if (inp2) { inp2.click(); inp2.checked = true; inp2.dispatchEvent(new Event('change', {bubbles:true})); }
          return 'text_partial_' + k;
        }
      }

      // ══════ Debug info ══════
      var debug = [];
      gRadios.forEach(function(el, idx) {
        debug.push('g' + idx + ':dv=' + (el.getAttribute('data-value')||'').substring(0,60) + '|txt=' + norm(el.textContent).substring(0,60));
      });
      inputs.forEach(function(inp, idx) {
        var p = inp.closest('label') || inp.parentElement;
        debug.push('i' + idx + ':' + (p ? norm(p.textContent).substring(0,60) : 'no-parent') + '|val=' + inp.value);
      });
      return 'no_match_found|answer=' + answer + '|label=' + label.substring(0,40) + '|options=' + debug.join(';');
    })()`;
    return await browserExecJS(browserName, js);
  }

  if (field.type === 'text' || field.type === 'select') {
    const js = `(function(){
      var label = ${labelJSON}.trim().toLowerCase();
      var answer = ${answerJSON};
      // Find input fields
      var inputs = document.querySelectorAll('input[type=text], input:not([type]), textarea, select');
      // Try to find by label association
      var labels = document.querySelectorAll('label');
      for (var i = 0; i < labels.length; i++) {
        if (labels[i].textContent.trim().toLowerCase().includes(label)) {
          var target = labels[i].htmlFor ? document.getElementById(labels[i].htmlFor) : labels[i].querySelector('input, textarea, select');
          if (target) {
            target.focus();
            if (target.tagName === 'SELECT') {
              for (var o = 0; o < target.options.length; o++) {
                if (target.options[o].text.trim().toLowerCase().includes(answer.toLowerCase())) {
                  target.selectedIndex = o;
                  target.dispatchEvent(new Event('change', {bubbles:true}));
                  return 'selected_option_' + o;
                }
              }
            } else {
              target.value = answer;
              target.dispatchEvent(new Event('input', {bubbles:true}));
              target.dispatchEvent(new Event('change', {bubbles:true}));
              return 'filled_input';
            }
          }
        }
      }
      // Fallback: first empty input on page
      for (var k = 0; k < inputs.length; k++) {
        if (!inputs[k].value || inputs[k].value === '') {
          inputs[k].focus();
          inputs[k].value = answer;
          inputs[k].dispatchEvent(new Event('input', {bubbles:true}));
          inputs[k].dispatchEvent(new Event('change', {bubbles:true}));
          return 'filled_fallback_' + k;
        }
      }
      return 'no_input_found';
    })()`;
    return await browserExecJS(browserName, js);
  }

  return 'unsupported_field_type';
}

// macOS mouse click fallback for non-browser apps
async function macClickAt(x, y) {
  const fs = require('fs');
  const os = require('os');

  // Use Python + Quartz CGEvent as the mouse click method
  const pyScript = `
import time
try:
    from Quartz.CoreGraphics import *
    from Quartz import CGWarpMouseCursorPosition
    p = (${x}, ${y})
    CGWarpMouseCursorPosition(p)
    time.sleep(0.15)
    move = CGEventCreateMouseEvent(None, kCGEventMouseMoved, p, kCGMouseButtonLeft)
    CGEventPost(kCGSessionEventTap, move)
    time.sleep(0.1)
    down = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, p, kCGMouseButtonLeft)
    CGEventSetIntegerValueField(down, kCGMouseEventClickState, 1)
    CGEventPost(kCGSessionEventTap, down)
    time.sleep(0.1)
    up = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, p, kCGMouseButtonLeft)
    CGEventSetIntegerValueField(up, kCGMouseEventClickState, 1)
    CGEventPost(kCGSessionEventTap, up)
    print('click_done')
except Exception as e:
    print('error: ' + str(e))
`;
  const sp = path.join(os.tmpdir(), 'silentgpt_click.py');
  fs.writeFileSync(sp, pyScript);
  try {
    const r = await execPromise(`/usr/bin/python3 "${sp}" 2>&1`, 8000);
    console.log('[Autopilot] CGEvent click result:', r.trim());
    if (r.includes('click_done')) return;
  } catch(e) { console.log('[Autopilot] CGEvent failed:', e.message); }

  // Swift binary fallback
  const clickerPath = path.join(process.resourcesPath, 'helpers', 'silentgpt-clicker');
  if (require('fs').existsSync(clickerPath)) {
    try {
      await execPromise(`chmod +x "${clickerPath}" && "${clickerPath}" ${x} ${y}`, 5000);
      return;
    } catch(e) { console.log('[Autopilot] Swift failed:', e.message); }
  }
  throw new Error('All click methods failed');
}

// Windows: click at absolute screen coordinates using user32.dll
function winClickAt(x, y) {
  return execPromise(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -MemberDefinition '[DllImport(\\\"user32.dll\\\")]public static extern bool SetCursorPos(int x,int y);[DllImport(\\\"user32.dll\\\")]public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name U -Namespace W; [W.U]::SetCursorPos(${x},${y}); [W.U]::mouse_event(2,0,0,0,0); [W.U]::mouse_event(4,0,0,0,0)"`, 5000);
}

ipcMain.handle('autopilot-execute', async (_ev, { fields }) => {
  if (!fields || !fields.length) return { success: false, error: 'No fields to fill' };

  console.log('[Autopilot] Executing', fields.length, 'fields:', JSON.stringify(fields));

  // ── macOS: check Accessibility permission (required for CGEvent clicks) ──
  if (process.platform === 'darwin') {
    const { systemPreferences } = require('electron');
    // Passing true shows the macOS prompt asking the user to grant access
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    console.log('[Autopilot] Accessibility trusted:', trusted);
    if (!trusted) {
      // Show overlay with error telling user to grant permission
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('autopilot-result', {
          success: false,
          error: 'SilentGPT needs Accessibility permission. Go to System Settings → Privacy & Security → Accessibility → enable SilentGPT, then try again.'
        });
      }
      return { success: false, error: 'accessibility_not_granted' };
    }
  }

  // Hide overlay so we can interact with the underlying app
  if (overlayWin) { overlayWin.hide(); overlayUp = false; stopLockdownKeepAlive(); }
  await sleep(400);

  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  console.log('[Autopilot] Display scale factor:', scale);
  const results = [];

  // ── Autopilot settings for human-like behavior ──
  const apDelay      = store.get('autopilotDelay') || 800;
  const apDelayRand  = store.get('autopilotDelayRandom') || 500;
  const apHumanize   = store.get('autopilotHumanize') !== false;
  const apScrollTo   = store.get('autopilotScrollTo') !== false;

  function humanDelay() {
    const base = apDelay;
    const rand = apHumanize ? Math.floor(Math.random() * apDelayRand) : 0;
    // Occasional longer pause to mimic reading/thinking
    const thinkPause = apHumanize && Math.random() < 0.15 ? Math.floor(Math.random() * 600) : 0;
    return base + rand + thinkPause;
  }

  // ── Detect if a browser is running — if so, use JS injection (100% reliable) ──
  let browserName = null;
  if (process.platform === 'darwin') {
    browserName = await detectFrontBrowser();
    console.log('[Autopilot] Detected browser:', browserName || 'NONE (will use mouse clicks)');
  }

  if (browserName) {
    // ══════ BROWSER MODE: inject JavaScript to click/fill answers directly ══════
    console.log('[Autopilot] Using browser JS injection via', browserName);

    for (let fi = 0; fi < fields.length; fi++) {
      const field = fields[fi];
      console.log(`[Autopilot] Field "${field.label}" type=${field.type} answer="${field.answer}"`);

      // Scroll element into view if enabled
      if (apScrollTo) {
        try {
          const scrollJS = `(function(){var el=document.querySelector('[value="${(field.answer||'').replace(/"/g,'\\"')}"]');if(el)el.scrollIntoView({behavior:'smooth',block:'center'});'scrolled'})()`;
          await browserExecJS(browserName, scrollJS);
          await sleep(200);
        } catch(_){}
      }

      try {
        const jsResult = await browserClickAnswer(browserName, field);
        const resultStr = (jsResult || '').toString().trim();
        console.log(`[Autopilot] JS result for "${field.label}":`, resultStr);

        if (resultStr.includes('no_match') || resultStr.includes('no_input')) {
          results.push({ label: field.label || '?', ok: false, reason: 'Could not find matching element on page' });
        } else {
          results.push({ label: field.label || '?', ok: true });
        }
        // Human-like delay between questions
        if (fi < fields.length - 1) await sleep(humanDelay());
      } catch (err) {
        console.log(`[Autopilot] JS injection error for "${field.label}":`, err.message);
        results.push({ label: field.label || '?', ok: false, reason: err.message });
      }
    }
  } else {
    // ══════ NON-BROWSER MODE: use mouse clicks (macOS CGEvent / Windows user32) ══════
    // Bring the previously-active app to front
    if (process.platform === 'darwin') {
      try {
        await execPromise(`osascript -e 'tell application "System Events"' -e 'set procs to every process whose frontmost is false and visible is true and name is not "SilentGPT" and name is not "Electron"' -e 'if (count of procs) > 0 then' -e 'set frontmost of item 1 of procs to true' -e 'end if' -e 'end tell'`, 3000);
      } catch(e) { console.log('[Autopilot] Focus error:', e.message); }
      await sleep(500);
    }

    for (let fi = 0; fi < fields.length; fi++) {
      const field = fields[fi];
      if (!field.clickX || !field.clickY) {
        results.push({ label: field.label || '?', ok: false, reason: 'no coordinates' });
        continue;
      }

      const x = Math.round(field.clickX / scale);
      const y = Math.round(field.clickY / scale);
      console.log(`[Autopilot] Field "${field.label}" type=${field.type} answer="${field.answer}" coords=(${x},${y})`);

      try {
        if (process.platform === 'darwin') {
          await macClickAt(x, y);
        } else {
          await winClickAt(x, y);
        }
        await sleep(300);

        // If text/select field, type the answer after clicking
        if ((field.type === 'text' || field.type === 'select') && field.answer) {
          if (process.platform === 'darwin') {
            await execPromise(`osascript -e 'tell application "System Events" to keystroke "a" using command down'`, 3000);
            await sleep(100);
            const escaped = field.answer.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "'\\''");
            await execPromise(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`, 15000);
          } else {
            await execPromise(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait('${field.answer.replace(/[+^%~(){}[\]]/g, '{$&}')}')"`, 15000);
          }
        }

        results.push({ label: field.label || '?', ok: true });
        // Human-like delay between questions
        if (fi < fields.length - 1) await sleep(humanDelay());
      } catch (err) {
        console.log(`[Autopilot] Click error:`, err.message);
        results.push({ label: field.label || '?', ok: false, reason: err.message });
      }
    }
  }

  // Show overlay again with results
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.show();
    overlayUp = true;
    initScreenCaptureDetection();
  }

  return { success: true, results, filled: results.filter(r => r.ok).length, total: results.length };
});

ipcMain.on('open-settings', () => makeSettings());

// Pinned answer window — small floating window that shows the answer after closing overlay
ipcMain.handle('pin-answer', (_ev, html) => {
  if (pinnedWin && !pinnedWin.isDestroyed()) { pinnedWin.close(); pinnedWin = null; }
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea || { x: 0, y: 0, width: display.size.width, height: display.size.height };
  const w = Math.min(340, Math.max(280, workArea.width - 40));
  const h = Math.min(260, Math.max(180, workArea.height - 40));
  pinnedWin = new BrowserWindow({
    x: workArea.x + workArea.width - w - 20,
    y: workArea.y + 60,
    width: w, height: h,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    hasShadow: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  enforceContentProtection(pinnedWin);
  try { pinnedWin.setAlwaysOnTop(true, 'screen-saver', 1); } catch (_) { pinnedWin.setAlwaysOnTop(true); }
  if (process.platform === 'darwin') { try { pinnedWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {} }
  const page = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{background:transparent;overflow:hidden;font-family:'SF Pro Display',system-ui,-apple-system,'Segoe UI',sans-serif}
    .wrap{background:rgba(13,20,18,0.94);backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border:1px solid rgba(111,143,132,0.22);border-radius:14px;color:#eef5f0;font-size:13px;line-height:1.5;display:flex;flex-direction:column;height:100vh;overflow:hidden}
    .bar{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;-webkit-app-region:drag;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0}
    .bar span{font-size:11px;color:#b8b0a0;font-weight:600}
    .bar button{-webkit-app-region:no-drag;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.2);color:#ef4444;font-size:10px;padding:3px 10px;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:600}
    .bar button:hover{background:rgba(239,68,68,0.25)}
    .body{padding:12px;overflow-y:auto;flex:1;font-size:13px;line-height:1.6;color:#e8e0d8}
    .body strong{color:#fff} .body code{background:rgba(111,143,132,0.16);padding:1px 5px;border-radius:4px;font-size:12px}
    .body pre{background:rgba(8,8,8,0.8);padding:10px;border-radius:8px;overflow-x:auto;font-size:12px;margin:8px 0}
  </style></head><body><div class="wrap">
    <div class="bar"><span>Pinned Answer</span><button onclick="window.close()">Close</button></div>
    <div class="body">${html.replace(/`/g, '\\`').replace(/\$/g, '\\$')}</div>
  </div></body></html>`;
  pinnedWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  pinnedWin.on('closed', () => { pinnedWin = null; });
  // Close the overlay after pinning
  if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.hide(); overlayUp = false; stopLockdownKeepAlive(); }
  return { ok: true };
});

ipcMain.on('open-app', () => {
  // Show the settings window as the "main app"
  makeSettings();
});

// Force Close — kill everything: overlay, pinned window, watchdog, tray, then quit
// Uses process.exit as final fallback to guarantee shutdown
ipcMain.on('force-close', () => {
  // 1. Stop background processes, kernel shield, and remove persistence
  try { shutdownKernelShield(); } catch (_) {}
  try { stopWatchdog(); } catch (_) {}
  try { removePersistence(); } catch (_) {}
  try { globalShortcut.unregisterAll(); } catch (_) {}
  try { if (lockdownKeepAlive) { clearInterval(lockdownKeepAlive); lockdownKeepAlive = null; } } catch (_) {}

  // 2. Allow close on all windows (bypass close resistance)
  try {
    const allWins = BrowserWindow.getAllWindows();
    for (const w of allWins) {
      try { if (w._silentgptAllowClose) w._silentgptAllowClose(); } catch (_) {}
    }
  } catch (_) {}

  // 3. Destroy non-sender windows first
  try { if (pinnedWin && !pinnedWin.isDestroyed()) { pinnedWin.destroy(); pinnedWin = null; } } catch (_) {}
  try { if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.destroy(); overlayWin = null; overlayUp = false; } } catch (_) {}
  try { if (flashcardsWin && !flashcardsWin.isDestroyed()) { flashcardsWin.destroy(); flashcardsWin = null; } } catch (_) {}
  try { if (tray) { tray.destroy(); tray = null; } } catch (_) {}

  // 4. Force quit after a tiny delay so the IPC response can complete
  //    Settings window (the sender) gets killed by app.exit
  setTimeout(() => {
    try { app.exit(0); } catch (_) {}
    // Ultimate fallback — if app.exit didn't work, force kill the process
    setTimeout(() => { process.exit(0); }, 500);
  }, 100);
});

/* ─────────── Self-Destruct: nuke everything and vanish ─────────── */
// Double-press safety: must press hotkey twice within 3 seconds to trigger
let selfDestructArmed = false;
let selfDestructTimer = null;

function selfDestructTrigger() {
  if (!selfDestructArmed) {
    // First press — arm it, notify user via overlay
    selfDestructArmed = true;
    try {
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('self-destruct-armed');
      }
    } catch (_) {}
    selfDestructTimer = setTimeout(() => {
      selfDestructArmed = false;
      try {
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('self-destruct-disarmed');
        }
      } catch (_) {}
    }, 3000);
    return;
  }
  // Second press within 3 seconds — execute
  clearTimeout(selfDestructTimer);
  selfDestructArmed = false;
  selfDestructExecute();
}

function selfDestructExecute() {
  try { shutdownKernelShield(); } catch (_) {}
  try { stopWatchdog(); } catch (_) {}
  try { removePersistence(); } catch (_) {}
  try { globalShortcut.unregisterAll(); } catch (_) {}
  try { if (lockdownKeepAlive) { clearInterval(lockdownKeepAlive); lockdownKeepAlive = null; } } catch (_) {}

  // 1. Clear all user config (local only — Stripe subscription stays valid)
  try { store.clear(); } catch (_) {}
  try {
    const configPath = path.join(app.getPath('userData'));
    if (fs.existsSync(configPath)) fs.rmSync(configPath, { recursive: true, force: true });
  } catch (_) {}

  // 2. Delete the app binary from disk
  const appPath = process.platform === 'darwin'
    ? app.getPath('exe').replace(/\/Contents\/MacOS\/.+$/, '')   // → /Applications/SilentGPT.app
    : path.dirname(app.getPath('exe'));                           // → C:\Program Files\SilentGPT

  // 3. Schedule delayed deletion so it runs after the process exits
  if (process.platform === 'darwin') {
    try {
      exec(`(sleep 2 && rm -rf "${appPath}") &`, { detached: true, stdio: 'ignore' });
    } catch (_) {}
  } else if (process.platform === 'win32') {
    try {
      const ps = `Start-Process powershell -WindowStyle Hidden -ArgumentList '-Command','Start-Sleep -Seconds 2; Remove-Item -Recurse -Force \\\"${appPath.replace(/\\/g, '\\\\')}\\\"'`;
      exec(`powershell -WindowStyle Hidden -Command "${ps}"`, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (_) {}
  }

  // 4. Kill all windows and quit
  try {
    const allWins = BrowserWindow.getAllWindows();
    for (const w of allWins) {
      try { if (w._silentgptAllowClose) w._silentgptAllowClose(); } catch (_) {}
      try { w.destroy(); } catch (_) {}
    }
  } catch (_) {}
  try { if (tray) { tray.destroy(); tray = null; } } catch (_) {}

  setTimeout(() => {
    try { app.exit(0); } catch (_) {}
    setTimeout(() => { process.exit(0); }, 500);
  }, 100);
}

ipcMain.on('self-destruct', () => { selfDestructTrigger(); });

const PRO_ONLY_SETTING_KEYS = ['lockdownMode','phantomMode','invisibleOverlay','ghostAnswer','clearScreen'];

function sanitizedSettings() {
  const settings = { ...store.store, proAccess: hasProAccess(), appUnlocked: isAppUnlocked() };
  if (!settings.proAccess) PRO_ONLY_SETTING_KEYS.forEach((key) => { settings[key] = false; });
  return settings;
}

ipcMain.handle('get-settings', () => sanitizedSettings());

// Recapture screen — hide overlay briefly, grab new screenshot, send back
ipcMain.handle('recapture-screen', async () => {
  if (!overlayWin || overlayWin.isDestroyed()) return null;
  if (isLockdown()) {
    // Lockdown mode: use opacity trick instead of hide/show (SEB may block re-show)
    try { overlayWin.setOpacity(0); } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
    const img = await grabScreenNative();
    try { overlayWin.setOpacity(1); } catch (_) {}
    applyOverlayLevel();
    return img;
  }
  overlayWin.hide();
  await new Promise(r => setTimeout(r, 300));
  const img = await grabScreen();
  overlayWin.show();
  applyOverlayLevel();
  return img;
});

ipcMain.handle('get-system-audio-source', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    });
    const source = sources[0];
    return source ? { id: source.id, name: source.name } : { error: 'No screen source available for system audio capture.' };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('save-settings', (_ev, s) => {
  // Block renderer from modifying license/auth fields
  const protectedKeys = ['licenseKey','licenseValid','licenseEmail','stripeCustomerId','stripeSubscriptionId','subscriptionStatus','membershipTier','authDone','authPasswordHash','onboardingDone'];
  const proAccess = hasProAccess();
  for (const [k, v] of Object.entries(s)) {
    if (protectedKeys.includes(k)) continue;
    if (!proAccess && PRO_ONLY_SETTING_KEYS.includes(k)) { store.set(k, false); continue; }
    store.set(k, v);
  }
  bindKeys();
  applyProcessDisguise(); // Re-apply disguise if lockdown mode was toggled
  if (proAccess && store.get('lockdownMode')) { activateKernelStealth(); installPersistence(); } else { deactivateKernelStealth(); removePersistence(); }
  if (s.startAtLogin !== undefined) {
    try { app.setLoginItemSettings({ openAtLogin: s.startAtLogin }); } catch (_) {}
  }
  refreshCaptureProtection();
  if (overlayWin)  overlayWin.webContents.send('load-settings', sanitizedSettings());
  if (settingsWin) settingsWin.webContents.send('settings-saved');
});

/* ─────────────────── AI Request ─────────────────── */

function configuredOpenAIKey() {
  let apiKey = OPENAI_API_KEY;
  if (apiKey === OPENAI_KEY_PLACEHOLDER) {
    const stored = store.get('openaiKey');
    if (stored && stored !== OPENAI_KEY_PLACEHOLDER && stored.length > 10) apiKey = stored;
  }
  return apiKey;
}

ipcMain.handle('transcribe-audio', async (_ev, { dataUrl, mimeType }) => {
  if (!isAppUnlocked()) return { error: 'Choose Lite or Pro to use SilentGPT.' };
  const apiKey = configuredOpenAIKey();
  if (!apiKey || apiKey === OPENAI_KEY_PLACEHOLDER) return { error: 'OpenAI API key not configured.' };

  const match = String(dataUrl || '').match(/^data:([^;]*);base64,(.*)$/);
  if (!match) return { error: 'No audio data received.' };
  if (!match[2]) return { error: 'Audio stream is active, but the recorded chunk was empty. Check that the source is playing and not muted.' };

  try {
    const audioMime = mimeType || match[1] || 'audio/webm';
    const ext = audioMime.includes('mp4') ? 'mp4' : audioMime.includes('wav') ? 'wav' : 'webm';
    const bytes = Buffer.from(match[2], 'base64');
    const form = new FormData();
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('response_format', 'json');
    form.append('file', new Blob([bytes], { type: audioMime }), `interview.${ext}`);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: form
    });
    if (!res.ok) return { error: `Transcription error (${res.status}): ${await res.text()}` };
    const data = await res.json();
    return { text: (data.text || '').trim() };
  } catch (err) {
    return { error: 'Transcription failed: ' + err.message };
  }
});

ipcMain.handle('ai-request', async (_ev, { mode, text, imageDataUrl, images, region, language }) => {
  // Revalidate subscription if last check was >10 min ago (non-blocking for fresh checks)
  const lastCheck = store.get('lastSubscriptionCheck') || 0;
  if (store.get('stripeSubscriptionId') && Date.now() - lastCheck > 10 * 60 * 1000) {
    try { await checkSubscriptionStatus(true); } catch (_) {}
  }
  // Block AI usage until users choose free Lite or paid Pro.
  if (!isAppUnlocked()) return { error: 'Choose Lite or Pro to use SilentGPT.' };
  // Track usage analytics
  trackUsage(mode || 'answer');

  // Determine which AI provider to use:
  // - Research mode → Perplexity (legacy source-focused mode)
  // - Everything else → OpenAI GPT-5.4 mini (better vision, accuracy, JSON)
  const usePerplexity = (mode === 'research');

  let apiKey, endpoint, model;
  const tokens = store.get('maxTokens');

  if (usePerplexity) {
    // Perplexity for research
    apiKey = BUILT_IN_API_KEY;
    if (apiKey === API_PLACEHOLDER) {
      const stored = store.get('apiKey');
      if (stored && stored !== API_PLACEHOLDER && stored.length > 10) apiKey = stored;
    }
    endpoint = 'https://api.perplexity.ai/chat/completions';
    model = 'sonar-pro';
  } else {
    // OpenAI GPT-5.4 mini for all other modes
    apiKey = OPENAI_API_KEY;
    if (apiKey === OPENAI_KEY_PLACEHOLDER) {
      const stored = store.get('openaiKey');
      if (stored && stored !== OPENAI_KEY_PLACEHOLDER && stored.length > 10) apiKey = stored;
    }
    // Fallback to Perplexity if OpenAI key not available
    if (!apiKey || apiKey === OPENAI_KEY_PLACEHOLDER) {
      apiKey = BUILT_IN_API_KEY;
      if (apiKey === API_PLACEHOLDER) {
        const stored = store.get('apiKey');
        if (stored && stored !== API_PLACEHOLDER && stored.length > 10) apiKey = stored;
      }
      endpoint = 'https://api.perplexity.ai/chat/completions';
      model = 'sonar-pro';
    } else {
      endpoint = 'https://api.openai.com/v1/chat/completions';
      model = 'gpt-5.4-mini';
    }
  }

  if (!apiKey || apiKey === API_PLACEHOLDER || apiKey === OPENAI_KEY_PLACEHOLDER) {
    return { error: 'API key not configured. Please reinstall SilentGPT or contact support.' };
  }

  console.log(`[AI] Mode: ${mode}, Provider: ${endpoint.includes('openai') ? 'OpenAI GPT-5.4 mini' : 'Perplexity'}`);


  // If we have nothing (no text, no image), show helpful error
  if (!text && !imageDataUrl) {
    if (isLockdown()) {
      return { error: 'Screen capture failed in Stealth Mode.\nPress Tab to type your question manually, then press Enter.\nIf on macOS, grant Screen Recording permission in System Settings → Privacy.' };
    }
    return { error: 'Screen capture failed. Please try:\n1. Open System Settings → Privacy & Security → Screen Recording\n2. Toggle SilentGPT OFF then ON again\n3. Quit SilentGPT completely (right-click tray → Quit) and reopen it' };
  }

  const prompts = {
    answer:    "You are a helpful AI assistant. ALWAYS start your response with the direct answer on the first line, clearly stated. For math problems or equations visible in an image, you MUST compute the actual final answer first (e.g. 'Answer: x = 7' or 'Answer: 42') before explaining. Never only describe how to solve it; if enough information is visible, finish the calculation. Then leave a blank line and provide a brief explanation if needed. FORMATTING RULES: Never use LaTeX commands like \\frac{}{}, \\left, \\right, \\int, \\sum, \\sqrt, etc. Instead write math in plain readable text: use / for fractions (e.g. '3/4' not '\\frac{3}{4}'), ^ for exponents (e.g. 'x^2'), sqrt() for roots, and Unicode symbols where helpful (∫, Σ, π, ∞, ², ³). Keep responses concise — no more than 8-10 lines. If the content contains math or science notation in the image, read it VERY carefully. Pay close attention to exponents, fractions, subscripts, and special symbols.",
    simple:    "You are a helpful AI assistant. Give ONLY the final answer — no explanation, no steps, no reasoning, no extra words. If it's a math problem, just the number or expression. If it's a question, just the answer. If it's multiple choice, just the letter. Nothing else. NEVER use LaTeX commands — write math in plain text with / for fractions, ^ for exponents, sqrt() for roots. Read mathematical notation from the image extremely carefully.",
    translate: `You are a professional translator. Translate ALL the provided text into ${language || store.get('language')}. Only provide the translation, no explanations.`,
    summarize: 'You are an expert summarizer. Start with a one-line summary, then key takeaways. Be concise. Never use LaTeX formatting.',
    explain:   'You are an expert teacher. Start with the direct answer, then explain step by step. For math problems or equations visible in an image, compute the actual final answer before explaining; never only describe the method. Keep it clear and readable. NEVER use LaTeX commands like \\frac, \\left, \\right — write math in plain text with / for fractions, ^ for exponents, sqrt() for roots, and Unicode symbols (∫, Σ, π, ², ³). If the content contains math or science, read all notation from the image VERY carefully.',
    solve:     'You are an expert tutor. Solve the problem completely. First line MUST be the actual final answer (e.g. "Answer: x = 7" or "Answer: 42"). Then show the step-by-step work exactly as a student would write it on paper. Number each step clearly. Do not only explain the method; complete the arithmetic/algebra/calculus and give the final numeric or symbolic result. Repeat the final answer on its own line at the end (e.g. "Final Answer: 42"). NEVER use LaTeX — write math in plain text with / for fractions, ^ for exponents, sqrt() for roots, and Unicode symbols (∫, Σ, π, ∞, ², ³). Read all notation from the image VERY carefully.',
    essay:     'You are an academic essay writer. Write a well-structured essay on the topic shown. Include: a clear thesis statement, 3-4 body paragraphs with topic sentences and supporting evidence, and a strong conclusion. Use formal academic tone. Aim for 500-800 words. Write in proper paragraph form — no bullet points or lists.',
    code:      'You are an expert programmer. Write clean, well-documented code to solve the problem shown. Use markdown code blocks with the correct language specifier (e.g. ```python, ```javascript, ```java, ```cpp). Include comments explaining key logic. Follow best practices: meaningful variable names, error handling, efficiency. If the language is not specified, infer it from context.',
    interview: 'You are an interview copilot. A live audio transcript may contain filler words, partial sentences, or background conversation. When the transcript contains an interview question, answer it directly as a strong candidate would say it aloud. Keep the response concise, natural, and interview-ready: start with the answer, add 2-4 supporting points, and include a brief example when useful. Do not mention transcripts, audio, or that you are an AI.',
    research:  store.get('credibleSourcesOnly')
      ? 'You are a research specialist. Provide a thorough analysis using ONLY credible academic and institutional sources (.edu, .org, .gov domains). Do NOT cite .com or commercial sources. Structure: 1) Brief overview, 2) Key findings with data from credible sources only, 3) References — list only .edu/.org/.gov URLs. Be factual and thorough.'
      : 'You are a research specialist. Provide a thorough, well-organized analysis of the topic shown. Structure your response as: 1) Brief overview, 2) Key findings with specific details and data, 3) Sources and references at the end. Use real, credible sources where possible. Be factual and detailed.',
    email:     'You are a professional communication expert. Draft a polished email reply based on the context shown on screen. Match the tone and formality of the original message. Include an appropriate greeting, clear and concise body, and professional closing. Return ONLY the email text — no Subject line, no "To:" field, no metadata.',
    flashcards:'You are an educational content creator. Generate 5-8 Q&A flashcards from the material shown on screen. Format each as: **Q:** [question] followed by **A:** [concise answer]. Focus on key concepts, definitions, formulas, and important facts. Number each flashcard.',
    autopilot: 'You are a quiz/form auto-fill AI. Analyze the screenshot and identify ALL visible questions and form fields. Return ONLY valid JSON — no markdown, no code fences, no explanation. Format: {"fields":[{"label":"question or field label","type":"radio","answer":"the correct answer","clickX":123,"clickY":456}],"nextBtn":null}. Field types: "radio" for multiple choice (clickX/clickY = center of the correct radio button/option to click), "checkbox" for checkboxes, "text" for text inputs or textareas (clickX/clickY = center of the input field), "select" for dropdowns. Coordinates must be in pixels matching the image dimensions, measured from top-left corner. For multiple choice: identify the CORRECT answer and provide coordinates of that specific option. Answer every question correctly using your knowledge. Be extremely precise with coordinates — they will be used to click.'
  };

  // If simpleMode toggle is ON, override 'answer' mode to use 'simple' prompt
  const effectiveMode = (mode === 'answer' && store.get('simpleMode')) ? 'simple' : mode;
  let systemPrompt = prompts[effectiveMode] || prompts.answer;
  if (['answer', 'simple', 'solve', 'essay', 'code', 'research', 'interview', 'flashcards'].includes(effectiveMode)) {
    systemPrompt += '\n\nWhen math notation is useful, format it as LaTeX using \\( ... \\) for inline math and \\[ ... \\] for displayed equations so the overlay can render it clearly.';
  }
  // Prepend user's custom AI context if set
  const aiContext = (store.get('aiContext') || '').trim();
  if (aiContext) {
    systemPrompt = 'IMPORTANT USER CONTEXT — follow these instructions for every response:\n' + aiContext + '\n\n' + systemPrompt;
  }
  const msgs = [{ role: 'system', content: systemPrompt }];

  // Build user message — include image(s) if available (GPT-5.4 mini has excellent vision)
  // Support multiple images via the `images` array
  const allImages = images && images.length > 0 ? images : (imageDataUrl ? [imageDataUrl] : []);
  const parts = [];
  if (text && allImages.length > 0) {
    parts.push({ type: 'text', text: text + '\n\n[NOTE: The above text was extracted via OCR and may contain errors, especially with math notation like exponents, fractions, and symbols. ALWAYS rely on the attached image(s) for the exact notation — the images are the ground truth. If a math problem or equation is visible, solve it fully and give the actual final answer first; do not just describe how to solve it.' + (allImages.length > 1 ? ' Multiple screen captures are provided — analyze ALL of them together.' : '') + ']' });
  } else if (text) {
    parts.push({ type: 'text', text: text });
  } else {
    parts.push({ type: 'text', text: allImages.length > 1
      ? 'Analyze ALL the screen captures shown in the images. Read any visible text carefully and respond to whatever questions or prompts are visible across all images. If a math problem or equation is visible, solve it fully and give the actual final answer first — do not just describe how to solve it.'
      : 'Analyze the selected screen region shown in the image. Read any visible text carefully and respond accordingly. If a math problem or equation is visible, solve it fully and give the actual final answer first — do not just describe how to solve it. Pay extra attention to mathematical notation — exponents, fractions, integrals, subscripts, and special symbols.' });
  }
  for (const img of allImages) {
    parts.push({ type: 'image_url', image_url: { url: img, detail: 'high' } });
  }
  // If we only have text (no image), send as simple string for compatibility
  if (parts.length === 1 && parts[0].type === 'text') {
    msgs.push({ role: 'user', content: parts[0].text });
  } else {
    msgs.push({ role: 'user', content: parts });
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages: msgs, max_completion_tokens: tokens, temperature: 0 })
    });
    if (!res.ok) return { error: `API Error (${res.status}): ${await res.text()}` };
    const data = await res.json();
    let result = data.choices?.[0]?.message?.content || 'No response received.';

    return { result, usage: data.usage };
  } catch (err) {
    return { error: 'Request failed: ' + err.message };
  }
});

/* ─────────────────── License / Activation ─────────────────── */

let activateWin = null;

function normalizeEmail(email) {
  return (email || '').toLowerCase().trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function planPriceId(plan) {
  return plan === 'annual' ? STRIPE_ANNUAL_PRICE_ID : STRIPE_PRICE_ID;
}

function subscriptionHasPremiumPrice(sub) {
  const items = sub?.items?.data || [];
  return items.some(item => PREMIUM_PRICE_IDS.has(item?.price?.id));
}

function currentAccountMatches(customerEmail) {
  const accountEmail = normalizeEmail(store.get('authEmail'));
  if (!accountEmail) return true;
  return normalizeEmail(customerEmail) === accountEmail;
}

function isPaidPremiumSubscription(sub, customerEmail) {
  if (!sub || sub.status !== 'active') return false;
  if (!subscriptionHasPremiumPrice(sub)) return false;
  if (!currentAccountMatches(customerEmail)) return false;
  return true;
}

function isLicensed() {
  return hasProAccess();
}

function trialDaysLeft() {
  const trialStart = store.get('trialStarted');
  if (!trialStart) return 0;
  const trialDays = store.get('trialDays') || 7;
  const elapsed = (Date.now() - trialStart) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.ceil(trialDays - elapsed));
}

function sendActivateUpgradeIntent() {
  if (!activateWin || activateWin.isDestroyed()) return;
  activateWin.webContents.send('open-upgrade-screen', { tier: 'pro' });
}

function showActivate(options = {}) {
  const openUpgrade = options.openUpgrade === true;

  if (activateWin && !activateWin.isDestroyed()) {
    activateWin.focus();
    if (openUpgrade) {
      if (activateWin.webContents.isLoading()) {
        activateWin.webContents.once('did-finish-load', sendActivateUpgradeIntent);
      } else {
        sendActivateUpgradeIntent();
      }
    }
    return;
  }

  // Show dock so the activate window can be focused on macOS
  if (process.platform === 'darwin') app.dock?.show();

  const bounds = fitWindowToPrimaryDisplay(780, 820);
  const minSize = fitMinimumSize(560, 640);
  activateWin = new BrowserWindow({
    ...bounds,
    ...minSize,
    ...framelessWindowOptions(),
    resizable: true, minimizable: true, maximizable: true,
    title: 'Activate SilentGPT',
    backgroundColor: '#020403',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  activateWin.loadFile(path.join(__dirname, 'activate.html'), openUpgrade ? { query: { upgrade: 'pro' } } : undefined);
  enforceContentProtection(activateWin);
  activateWin.once('ready-to-show', () => { activateWin.show(); activateWin.focus(); });
  if (openUpgrade) activateWin.webContents.once('did-finish-load', sendActivateUpgradeIntent);
  activateWin.on('closed', () => {
    activateWin = null;
    if (isAppUnlocked()) {
      if (process.platform === 'darwin') app.dock?.hide();
    } else {
      // Don't quit — stay in tray so user can re-open via hotkey or tray menu
      if (process.platform === 'darwin') app.dock?.hide();
    }
  });
}

ipcMain.on('start-trial', () => {
  // Trial disabled — license key required for access
  // Do nothing — user must enter a license key
});

ipcMain.handle('accept-terms', () => {
  store.set('termsAccepted', true);
  return { ok: true };
});

ipcMain.handle('start-free-lite', () => {
  store.set('termsAccepted', true);
  store.set('membershipTier', 'free');
  store.set('licenseValid', false);
  store.set('subscriptionStatus', store.get('stripeSubscriptionId') ? store.get('subscriptionStatus') : 'inactive');
  PRO_ONLY_SETTING_KEYS.forEach((key) => store.set(key, false));
  setImmediate(proceedAfterActivation);
  return { ok: true, tier: 'free' };
});

ipcMain.handle('open-upgrade-screen', () => {
  showActivate({ openUpgrade: true });
  return { ok: true };
});

ipcMain.handle('upgrade-to-pro-from-settings', async () => {
  const email = normalizeEmail(store.get('licenseEmail') || store.get('authEmail') || store.get('stripeEmail'));
  if (!isValidEmail(email)) {
    showActivate({ openUpgrade: true });
    return { opened: true, needsEmail: true };
  }

  try {
    const selectedPlan = 'monthly';
    const configError = stripeConfigError(selectedPlan);
    if (configError) {
      showActivate({ openUpgrade: true });
      return { opened: true, needsEmail: true, warning: configError };
    }

    const stripe = getStripe();
    if (!stripe) {
      showActivate({ openUpgrade: true });
      return { opened: true, needsEmail: true, warning: 'Payment system not configured.' };
    }

    const metadata = {
      app: 'silentgpt',
      hostname: require('os').hostname(),
      accountEmail: normalizeEmail(store.get('authEmail')) || email,
      plan: selectedPlan
    };

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: planPriceId(selectedPlan), quantity: 1 }],
      customer_email: email,
      client_reference_id: metadata.accountEmail,
      allow_promotion_codes: true,
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      metadata,
      subscription_data: { metadata }
    });

    await openCheckoutWindow(checkoutSession.url, checkoutSession.id);
    return { opened: true };
  } catch (err) {
    showActivate({ openUpgrade: true });
    return { opened: true, needsEmail: true, warning: err.message };
  }
});

// Admin master keys defined at top of file

function proceedAfterActivation() {
  // Close activate window (the closed handler will hide dock when access is available)
  if (activateWin) { activateWin.close(); activateWin = null; }
  // Lite and Pro both get the core app; Pro-only stealth features are gated separately.
  if (!overlayWin) makeOverlay();
  bindKeys();
  if (process.platform === 'darwin') app.dock?.hide();
  showMainMenuIfReady();
}

function proceedAfterLicense() {
  proceedAfterActivation();
}

// Admin key validation (still works for admin access)
ipcMain.handle('validate-license', async (_ev, key) => {
  if (!key || key.trim().length < 5) return { valid: false, error: 'Please enter a valid key.' };

  if (ADMIN_KEYS.includes(key.trim())) {
    store.set('licenseKey', key.trim());
    store.set('licenseValid', true);
    store.set('licenseEmail', 'admin@trysilentgpt.net');
    store.set('membershipTier', 'premium');
    store.set('subscriptionStatus', 'active');
    proceedAfterLicense();
    return { valid: true, email: 'admin@trysilentgpt.net', admin: true };
  }

  return { valid: false, error: 'Please use the Subscribe button to get access.' };
});

// Create Stripe Checkout Session — supports monthly and annual plans
ipcMain.handle('create-checkout-session', async (_ev, email, plan) => {
  try {
    const selectedPlan = plan === 'annual' ? 'annual' : 'monthly';
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) return { error: 'Please enter a valid email address.' };

    const configError = stripeConfigError(selectedPlan);
    if (configError) return { error: configError };

    const stripe = getStripe();
    if (!stripe) return { error: 'Payment system not configured. Please reinstall SilentGPT or contact support.' };

    const metadata = {
      app: 'silentgpt',
      hostname: require('os').hostname(),
      accountEmail: normalizeEmail(store.get('authEmail')) || normalizedEmail,
      plan: selectedPlan
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: planPriceId(selectedPlan), quantity: 1 }],
      customer_email: normalizedEmail,
      client_reference_id: metadata.accountEmail,
      allow_promotion_codes: true,
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      metadata,
      subscription_data: { metadata }
    });

    return { sessionId: session.id, url: session.url };
  } catch (err) {
    console.error('Stripe session creation failed:', err.message);
    return { error: err.message };
  }
});

// Open Stripe Checkout in a popup BrowserWindow
let checkoutWin = null;
let checkoutSucceeded = false;

async function openCheckoutWindow(url, sessionId) {
  if (checkoutWin) { checkoutWin.focus(); return { opened: true }; }

  checkoutSucceeded = false;

  // Show dock so checkout window can be focused
  if (process.platform === 'darwin') app.dock?.show();

  const bounds = fitWindowToPrimaryDisplay(500, 700);
  const minSize = fitMinimumSize(420, 560);
  checkoutWin = new BrowserWindow({
    ...bounds,
    ...minSize,
    ...framelessWindowOptions(),
    resizable: true, minimizable: false, maximizable: false,
    title: 'SilentGPT — Subscribe',
    backgroundColor: '#020403',
    icon: getAppIconImage(),
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  checkoutWin.loadURL(url);
  enforceContentProtection(checkoutWin);

  // Monitor navigation — detect success redirect
  checkoutWin.webContents.on('will-redirect', async (_e, redirectUrl) => {
    if (redirectUrl.includes('/checkout/success') && redirectUrl.includes('session_id=')) {
      const sid = new URL(redirectUrl).searchParams.get('session_id') || sessionId;
      const result = await activateFromSession(sid);
      if (result.valid) {
        checkoutSucceeded = true;
        if (checkoutWin && !checkoutWin.isDestroyed()) checkoutWin.close();
      }
    }
    // Handle cancel URL — auto-close checkout window
    if (redirectUrl.includes('/checkout/cancel')) {
      if (checkoutWin && !checkoutWin.isDestroyed()) checkoutWin.close();
    }
  });

  // Also check on any navigation (some redirects don't fire will-redirect)
  checkoutWin.webContents.on('did-navigate', async (_e, navUrl) => {
    if (navUrl.includes('/checkout/success')) {
      const sid = (() => { try { return new URL(navUrl).searchParams.get('session_id'); } catch (_) { return sessionId; } })();
      const result = await activateFromSession(sid || sessionId);
      if (result.valid) {
        checkoutSucceeded = true;
        if (checkoutWin && !checkoutWin.isDestroyed()) checkoutWin.close();
      }
    }
    // Handle cancel URL
    if (navUrl.includes('/checkout/cancel')) {
      if (checkoutWin && !checkoutWin.isDestroyed()) checkoutWin.close();
    }
  });

  checkoutWin.on('closed', () => {
    checkoutWin = null;
    if (process.platform === 'darwin' && isAppUnlocked()) app.dock?.hide();

    // Notify activate window that checkout closed without success
    if (!checkoutSucceeded && activateWin && !activateWin.isDestroyed()) {
      activateWin.webContents.send('checkout-cancelled');
    }
  });

  return { opened: true };
}

ipcMain.handle('open-checkout-window', async (_ev, url, sessionId) => openCheckoutWindow(url, sessionId));

// Validate subscription from a Checkout Session and activate
async function activateFromSession(sessionId) {
  try {
    const stripe = getStripe();
    if (!stripe) return { valid: false, error: 'Stripe not configured' };

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session.subscription) return { valid: false, error: 'No subscription in session' };

    const sub = await stripe.subscriptions.retrieve(session.subscription, {
      expand: ['customer', 'items.data.price']
    });
    const customer = typeof sub.customer === 'string'
      ? await stripe.customers.retrieve(sub.customer)
      : sub.customer;
    const customerEmail = customer?.email || session.customer_details?.email || session.customer_email || '';

    if (isPaidPremiumSubscription(sub, customerEmail)) {
      store.set('licenseKey', sub.id);
      store.set('stripeCustomerId', typeof sub.customer === 'string' ? sub.customer : sub.customer.id);
      store.set('stripeSubscriptionId', sub.id);
      store.set('stripeEmail', customerEmail);
      store.set('subscriptionStatus', sub.status);
      store.set('membershipTier', 'premium');
      store.set('licenseValid', true);
      store.set('licenseEmail', customerEmail);
      store.set('lastSubscriptionCheck', Date.now());

      proceedAfterLicense();
      return { valid: true, email: customerEmail, tier: 'premium' };
    }

    // Provide clear, actionable error messages
    const statusErrors = {
      past_due: 'Payment failed. Please update your card and try again.',
      canceled: 'This subscription has been cancelled.',
      unpaid: 'Payment is overdue. Please update your payment method.',
      incomplete: 'Payment did not complete. Please try again.',
      incomplete_expired: 'Payment session expired. Please subscribe again.',
      trialing: 'A paid premium subscription is required. Please complete payment to activate.'
    };

    if (!subscriptionHasPremiumPrice(sub)) return { valid: false, error: 'This subscription is not for a premium SilentGPT plan.' };
    if (!currentAccountMatches(customerEmail)) return { valid: false, error: 'Subscription email does not match the signed-in account.' };
    return { valid: false, error: statusErrors[sub.status] || ('Subscription status: ' + sub.status) };
  } catch (err) {
    console.error('activateFromSession failed:', err.message);
    return { valid: false, error: err.message };
  }
}

async function activateFromSubscription(sub, customerEmail) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  store.set('licenseKey', sub.id);
  store.set('stripeCustomerId', customerId);
  store.set('stripeSubscriptionId', sub.id);
  store.set('stripeEmail', customerEmail);
  store.set('subscriptionStatus', sub.status);
  store.set('membershipTier', 'premium');
  store.set('licenseValid', true);
  store.set('licenseEmail', customerEmail);
  store.set('lastSubscriptionCheck', Date.now());
  proceedAfterLicense();
  return { valid: true, email: customerEmail, tier: 'premium', subscriptionId: sub.id };
}

async function findPaidPremiumSubscriptionByEmail(email) {
  const stripe = getStripe();
  if (!stripe) return { valid: false, error: 'Payment system not configured.' };

  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) return { valid: false, error: 'Please enter a valid email address.' };

  const customers = await stripe.customers.list({ email: normalizedEmail, limit: 10 });
  for (const customer of customers.data) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 20,
      expand: ['data.customer', 'data.items.data.price']
    });

    const match = subscriptions.data.find(sub => isPaidPremiumSubscription(sub, customer.email || normalizedEmail));
    if (match) return activateFromSubscription(match, customer.email || normalizedEmail);
  }

  return { valid: false, error: 'No active SilentGPT subscription was found for that email.' };
}

// Validate subscription from stored session ID (called from renderer)
ipcMain.handle('validate-stripe-subscription', async (_ev, sessionId) => {
  return activateFromSession(sessionId);
});

ipcMain.handle('restore-stripe-subscription', async (_ev, email) => {
  try {
    return await findPaidPremiumSubscriptionByEmail(email);
  } catch (err) {
    console.error('restore-stripe-subscription failed:', err.message);
    return { valid: false, error: err.message };
  }
});

// Check subscription status — force=true skips cooldown (used by periodic timer)
async function checkSubscriptionStatus(force = false) {
  const subId = store.get('stripeSubscriptionId');
  if (!subId) {
    // Admin keys bypass subscription check
    if (ADMIN_KEYS.includes(store.get('licenseKey'))) return;
    // No subscription and not admin — revoke
    store.set('licenseValid', false);
    store.set('membershipTier', 'free');
    store.set('subscriptionStatus', 'inactive');
    return;
  }

  if (!force) {
    const lastCheck = store.get('lastSubscriptionCheck') || 0;
    const COOLDOWN = 10 * 60 * 1000; // 10 minutes between checks (was 24h)
    if (Date.now() - lastCheck < COOLDOWN) return;
  }

  try {
    const stripe = getStripe();
    if (!stripe) {
      store.set('licenseValid', false);
      store.set('membershipTier', 'free');
      store.set('subscriptionStatus', 'inactive');
      return;
    }

    const sub = await stripe.subscriptions.retrieve(subId, {
      expand: ['customer', 'items.data.price']
    });
    const customer = typeof sub.customer === 'string'
      ? await stripe.customers.retrieve(sub.customer)
      : sub.customer;
    const customerEmail = customer?.email || store.get('licenseEmail') || '';

    store.set('subscriptionStatus', sub.status);
    store.set('licenseEmail', customerEmail);
    store.set('stripeEmail', customerEmail);

    if (isPaidPremiumSubscription(sub, customerEmail)) {
      store.set('licenseValid', true);
      store.set('membershipTier', 'premium');
      store.set('lastSubscriptionCheck', Date.now());
    } else {
      // Only paid, active premium subscriptions unlock the app.
      store.set('licenseValid', false);
      store.set('membershipTier', 'free');
      store.set('lastSubscriptionCheck', Date.now());
    }
  } catch (err) {
    console.warn('Subscription check failed:', err.message);
    // If Stripe cannot confirm payment, do not grant access beyond the last
    // successfully verified active premium state.
    if (!hasProAccess()) {
      store.set('licenseValid', false);
      store.set('membershipTier', 'free');
    }
  }
}

ipcMain.handle('get-license-status', () => {
  return {
    licensed: isAppUnlocked(),
    proAccess: hasProAccess(),
    hasKey: !!store.get('licenseKey'),
    licenseValid: store.get('licenseValid'),
    trialActive: store.get('trialStarted') > 0 && trialDaysLeft() > 0,
    trialDaysLeft: trialDaysLeft(),
    email: store.get('licenseEmail') || '',
    subscriptionId: store.get('stripeSubscriptionId') || '',
    subscriptionStatus: store.get('subscriptionStatus') || 'inactive',
    membershipTier: hasProAccess() ? 'premium' : 'free'
  };
});

/* ─────────────────── Subscription Management ─────────────────── */

ipcMain.handle('get-subscription-info', async () => {
  const subId = store.get('stripeSubscriptionId');
  const info = {
    active: hasProAccess(),
    email: store.get('licenseEmail') || store.get('authEmail') || '',
    subscriptionId: subId || '',
    status: store.get('subscriptionStatus') || 'inactive',
    membershipTier: hasProAccess() ? 'premium' : 'free',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    isAdmin: ADMIN_KEYS.includes(store.get('licenseKey'))
  };

  // Fetch live data from Stripe if we have a subscription
  if (subId) {
    try {
      const stripe = getStripe();
      if (stripe) {
        const sub = await stripe.subscriptions.retrieve(subId);
        info.status = sub.status;
        info.cancelAtPeriodEnd = sub.cancel_at_period_end;
        info.currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null;
        store.set('subscriptionStatus', sub.status);
      }
    } catch (_) {}
  }

  return info;
});

ipcMain.handle('cancel-subscription', async () => {
  const subId = store.get('stripeSubscriptionId');
  if (!subId) return { success: false, error: 'No subscription found.' };

  try {
    const stripe = getStripe();
    if (!stripe) return { success: false, error: 'Payment system not configured.' };

    // Cancel at period end — user keeps access until billing cycle ends
    const sub = await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    store.set('subscriptionStatus', sub.status);
    return {
      success: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('reactivate-subscription', async () => {
  const subId = store.get('stripeSubscriptionId');
  if (!subId) return { success: false, error: 'No subscription found.' };

  try {
    const stripe = getStripe();
    if (!stripe) return { success: false, error: 'Payment system not configured.' };

    const sub = await stripe.subscriptions.update(subId, { cancel_at_period_end: false });
    store.set('subscriptionStatus', sub.status);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('create-billing-portal', async () => {
  const customerId = store.get('stripeCustomerId');
  if (!customerId) return { error: 'No customer record found.' };

  try {
    const stripe = getStripe();
    if (!stripe) return { error: 'Payment system not configured.' };

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: STRIPE_BILLING_PORTAL_RETURN_URL
    });

    return { url: session.url };
  } catch (err) {
    return { error: err.message };
  }
});

/* ─────────────────── Auth / Sign Up / Sign In ─────────────────── */

let authWin = null;

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

function showAuth() {
  if (authWin) { authWin.focus(); return; }

  // Show dock temporarily so auth window can be focused on macOS
  if (process.platform === 'darwin') app.dock?.show();

  const bounds = fitWindowToPrimaryDisplay(520, 660);
  authWin = new BrowserWindow({
    ...bounds,
    ...framelessWindowOptions(),
    resizable: false, minimizable: false, maximizable: false,
    title: 'SilentGPT — Sign In',
    backgroundColor: '#020403',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  authWin.loadFile(path.join(__dirname, 'auth.html'));
  enforceContentProtection(authWin);
  authWin.once('ready-to-show', () => { authWin.show(); authWin.focus(); });
  authWin.on('closed', () => {
    authWin = null;
    // Hide dock again after auth window closes
    if (process.platform === 'darwin') app.dock?.hide();
  });
}


function getSignupMetadata() {
  return {
    platform: process.platform,
    hostname: os.hostname(),
    version: require('../package.json').version,
    submittedAt: new Date().toISOString()
  };
}

async function notifyOwnerOfSignup(account) {
  const metadata = getSignupMetadata();
  const signup = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: account.name,
    email: account.email,
    ...metadata
  };

  const signups = store.get('accountSignups') || [];
  signups.unshift(signup);
  store.set('accountSignups', signups.slice(0, 250));

  const body = [
    'A new SilentGPT account was created from the desktop app.',
    '',
    '---',
    `**Name:** ${account.name}`,
    `**Email:** ${account.email}`,
    `**Platform:** ${metadata.platform}`,
    `**Hostname:** ${metadata.hostname}`,
    `**Version:** v${metadata.version}`,
    `**Created:** ${metadata.submittedAt}`
  ].join('\n');

  try {
    const issue = await ghAPI('POST', `/repos/${GITHUB_REPO}/issues`, {
      title: `[Account Created] ${account.name} <${account.email}>`,
      body
    });
    signup.ownerNotification = { delivered: true, issueNumber: issue.number, url: issue.html_url, deliveredAt: new Date().toISOString() };
    signups[0] = signup;
    store.set('accountSignups', signups.slice(0, 250));
    return { notified: true, ticketId: '#' + issue.number, url: issue.html_url };
  } catch (err) {
    signup.ownerNotification = { delivered: false, error: err.message, queuedAt: new Date().toISOString() };
    const pending = store.get('pendingSignupNotifications') || [];
    pending.unshift(signup);
    store.set('pendingSignupNotifications', pending.slice(0, 250));
    signups[0] = signup;
    store.set('accountSignups', signups.slice(0, 250));
    return { notified: false, queued: true, error: err.message };
  }
}

ipcMain.handle('auth-signup', async (_ev, { name, email, password }) => {
  if (!name || !email || !password) return { success: false, error: 'All fields are required.' };
  if (password.length < 6) return { success: false, error: 'Password must be at least 6 characters.' };

  // Check if account already exists with different email
  const existingEmail = store.get('authEmail');
  if (existingEmail && existingEmail !== email) {
    return { success: false, error: 'An account already exists. Please sign in instead.' };
  }

  // Store account locally
  store.set('authName', name);
  store.set('authEmail', email);
  store.set('authPasswordHash', simpleHash(password));
  store.set('authDone', true);

  const ownerNotice = await notifyOwnerOfSignup({ name, email });
  return { success: true, ...ownerNotice };
});

ipcMain.handle('auth-signin', async (_ev, { email, password }) => {
  if (!email || !password) return { success: false, error: 'Email and password are required.' };

  const storedEmail = store.get('authEmail');
  const storedHash = store.get('authPasswordHash');

  if (!storedEmail) {
    return { success: false, error: 'No account found. Please sign up first.' };
  }

  if (email !== storedEmail) {
    return { success: false, error: 'Invalid email or password.' };
  }

  if (simpleHash(password) !== storedHash) {
    return { success: false, error: 'Invalid email or password.' };
  }

  store.set('authDone', true);
  return { success: true };
});

ipcMain.on('auth-done', () => {
  store.set('authDone', true);
  if (authWin) { authWin.close(); authWin = null; }

  // After auth, show tour first, then payment
  if (!store.get('onboardingDone')) {
    showWelcome();
  } else if (!isAppUnlocked()) {
    showActivate();
  } else {
    showMainMenuIfReady();
  }
});

ipcMain.on('auth-logout', () => {
  store.set('authDone', false);
  try { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide(); } catch (_) {}
  showAuth();
  setTimeout(() => {
    try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); } catch (_) {}
  }, 100);
});

/* ─────────────────── Welcome / First Launch ─────────────────── */

let welcomeWin = null;

function showWelcome() {
  if (welcomeWin) { welcomeWin.focus(); return; }

  // Show dock temporarily so welcome window can be focused on macOS
  if (process.platform === 'darwin') app.dock?.show();

  const bounds = fitWindowToPrimaryDisplay(760, 600);
  welcomeWin = new BrowserWindow({
    ...bounds,
    ...framelessWindowOptions(),
    resizable: false, minimizable: false, maximizable: false,
    title: 'Welcome to SilentGPT',
    backgroundColor: '#020403',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  welcomeWin.loadFile(path.join(__dirname, 'welcome.html'));
  enforceContentProtection(welcomeWin);
  welcomeWin.once('ready-to-show', () => { welcomeWin.show(); welcomeWin.focus(); });
  welcomeWin.on('closed', () => {
    welcomeWin = null;
    // Hide dock again after welcome window closes
    if (process.platform === 'darwin') app.dock?.hide();
  });
}

ipcMain.on('welcome-done', () => {
  store.set('onboardingDone', true);
  if (welcomeWin) { welcomeWin.close(); welcomeWin = null; }

  // After tour, let users choose free Lite or paid Pro if app access is not unlocked.
  if (!isAppUnlocked()) {
    showActivate();
  } else {
    if (process.platform === 'darwin') app.dock?.hide();
    showMainMenuIfReady();
  }
});

/* ─────────────────── Replay Tour ─────────────────── */

ipcMain.on('replay-tour', () => {
  showWelcome();
});

/* ─────────────────── Changelog ─────────────────── */

ipcMain.handle('get-changelog', async () => {
  try {
    // Fetch from PUBLIC releases repo — private repo returns 404 without auth
    const res = await fetch('https://api.github.com/repos/Salt30/silentgpt-releases/releases?per_page=10');
    if (!res.ok) return [];
    const releases = await res.json();
    return releases.map(r => ({
      version: (r.tag_name || '').replace(/^v/, ''),
      name: r.name || r.tag_name,
      date: r.published_at ? new Date(r.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
      body: r.body || ''
    }));
  } catch (_) {
    return [];
  }
});

/* ─────────────────── Auto Update ─────────────────── */

ipcMain.handle('get-app-version', () => {
  return require('../package.json').version;
});

/* ─── Kernel Shield IPC ─── */

ipcMain.handle('kernel-shield-status', async () => {
  if (process.platform !== 'win32') return { available: false, platform: process.platform };
  return {
    available: !!(kernelShield && kernelShield.available()),
    platform: 'win32',
  };
});

ipcMain.handle('kernel-shield-install', async () => {
  if (process.platform !== 'win32') return { success: false, error: 'Windows only' };

  const driverLoaderPath = getKernelDriverLoaderPath();
  if (!driverLoaderPath) {
    return { success: false, error: 'Kernel shield installer is not included in this build.' };
  }

  try {
    const loader = require(driverLoaderPath);
    const result = await loader.installDriver();
    if (result.success) {
      // Re-init the shield now that driver is loaded
      initKernelShield();
      if (isLockdown()) activateKernelStealth();
    }
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-external', async (_ev, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
  }
  return { success: false };
});

// Proper semver comparison: returns true if a > b (e.g. "3.4.0" > "3.3.3")
function isNewerVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false; // equal
}

ipcMain.handle('check-for-updates', async () => {
  try {
    const currentVersion = require('../package.json').version;
    // Fetch from PUBLIC releases repo — private repo returns 404 without auth
    const res = await fetch('https://api.github.com/repos/Salt30/silentgpt-releases/releases/latest');
    if (!res.ok) return { upToDate: true, current: currentVersion };
    const data = await res.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    if (!latest) return { upToDate: true, current: currentVersion };

    // Only show update if latest release is actually newer than current version
    if (!isNewerVersion(latest, currentVersion)) return { upToDate: true, current: currentVersion };

    // Find all platform download URLs
    const assets = data.assets || [];
    const find = (ext) => { const a = assets.find(x => x.name.endsWith(ext)); return a ? a.browser_download_url : null; };
    return {
      upToDate: false,
      current: currentVersion,
      latest: latest,
      downloads: {
        macDmg: find('.dmg'),
        macZip: find('-mac.zip'),
        winExe: find('.exe'),
        winZip: find('-win.zip')
      },
      releaseUrl: data.html_url
    };
  } catch (_) {
    return { upToDate: true, error: 'Could not check for updates' };
  }
});

/* ─────────────────── Admin & Support ─────────────────── */

ipcMain.handle('is-admin', () => isAdmin());

ipcMain.handle('get-admin-stats', () => {
  if (!isAdmin()) return { error: 'Not authorized' };
  const firstLaunch = store.get('statsFirstLaunch') || Date.now();
  const daysSince = Math.max(1, Math.ceil((Date.now() - firstLaunch) / (1000 * 60 * 60 * 24)));
  return {
    firstLaunch: new Date(firstLaunch).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    totalSessions: store.get('statsTotalSessions') || 0,
    totalRequests: store.get('statsTotalRequests') || 0,
    lastUsed: store.get('statsLastUsed') ? new Date(store.get('statsLastUsed')).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never',
    daysSinceInstall: daysSince,
    avgRequestsPerDay: ((store.get('statsTotalRequests') || 0) / daysSince).toFixed(1),
    modes: {
      answer: store.get('statsAnswerCount') || 0,
      translate: store.get('statsTranslateCount') || 0,
      autopilot: store.get('statsAutopilotCount') || 0,
      dripType: store.get('statsDripTypeCount') || 0,
      summarize: store.get('statsSummarizeCount') || 0,
      explain: store.get('statsExplainCount') || 0
    },
    user: {
      name: store.get('authName') || 'Unknown',
      email: store.get('authEmail') || 'Unknown',
      licenseKey: store.get('licenseKey') || 'None',
      licenseEmail: store.get('licenseEmail') || '',
      platform: process.platform,
      version: require('../package.json').version,
      electronVersion: process.versions.electron
    },
    signups: store.get('accountSignups') || [],
    pendingSignupNotifications: store.get('pendingSignupNotifications') || [],
    tickets: store.get('supportTickets') || []
  };
});

/* ─────────────────── Support Tickets (GitHub Issues Backend) ─────────────────── */

function getGitHubToken() {
  if (GITHUB_SUPPORT_TOKEN !== GITHUB_SUPPORT_PLACEHOLDER) return GITHUB_SUPPORT_TOKEN;
  return null;
}

async function ghAPI(method, endpoint, body) {
  const token = getGitHubToken();
  if (!token) throw new Error('Support system not configured.');
  const opts = {
    method,
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'SilentGPT-App'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.github.com${endpoint}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
  return res.json();
}

ipcMain.handle('submit-ticket', async (_ev, { subject, description, email }) => {
  if (!subject || !description) return { success: false, error: 'Subject and description are required.' };

  const userEmail = email || store.get('authEmail') || '';
  const userName = store.get('authName') || 'Anonymous';
  const version = require('../package.json').version;

  // Build GitHub Issue body with metadata
  const body = [
    description.trim(),
    '',
    '---',
    `**User:** ${userName}`,
    `**Email:** ${userEmail}`,
    `**Platform:** ${process.platform}`,
    `**Version:** v${version}`,
    `**Submitted:** ${new Date().toISOString()}`
  ].join('\n');

  try {
    const issue = await ghAPI('POST', `/repos/${GITHUB_REPO}/issues`, {
      title: `[Support] ${subject.trim()}`,
      body,
      labels: ['support']
    });

    // Also cache locally for offline viewing
    const ticket = {
      id: String(issue.number),
      ghNumber: issue.number,
      subject: subject.trim(),
      description: description.trim(),
      email: userEmail,
      userName,
      platform: process.platform,
      version,
      status: 'open',
      createdAt: issue.created_at,
      ghUrl: issue.html_url
    };
    const tickets = store.get('supportTickets') || [];
    tickets.unshift(ticket);
    store.set('supportTickets', tickets);

    return { success: true, ticketId: '#' + issue.number, url: issue.html_url };
  } catch (err) {
    // Fallback to local-only if GitHub API fails
    const ticket = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      subject: subject.trim(),
      description: description.trim(),
      email: userEmail,
      userName,
      platform: process.platform,
      version,
      status: 'open',
      createdAt: new Date().toISOString()
    };
    const tickets = store.get('supportTickets') || [];
    tickets.unshift(ticket);
    store.set('supportTickets', tickets);
    return { success: true, ticketId: ticket.id, offline: true };
  }
});

ipcMain.handle('get-tickets', async () => {
  // Try fetching from GitHub first for the user's email
  const token = getGitHubToken();
  const userEmail = store.get('authEmail') || store.get('licenseEmail') || '';

  if (token && userEmail) {
    try {
      // Fetch support issues, match by email in the body
      const issues = await ghAPI('GET', `/repos/${GITHUB_REPO}/issues?labels=support&state=all&per_page=50&sort=created&direction=desc`);
      const userTickets = issues.filter(i => i.body && i.body.includes(userEmail));

      // Fetch comments for each ticket to get admin replies
      const tickets = await Promise.all(userTickets.map(async (i) => {
        let status = 'open';
        if (i.state === 'closed') status = 'resolved';
        if (i.labels.some(l => l.name === 'in-progress')) status = 'in-progress';
        if (i.labels.some(l => l.name === 'resolved')) status = 'resolved';
        if (i.labels.some(l => l.name === 'wont-fix')) status = 'closed';

        // Get the latest admin reply from comments
        let adminReply = null;
        try {
          const comments = await ghAPI('GET', `/repos/${GITHUB_REPO}/issues/${i.number}/comments?per_page=10`);
          const adminComments = comments.filter(c => c.body && c.body.startsWith('**Admin Reply:**'));
          if (adminComments.length > 0) {
            adminReply = adminComments[adminComments.length - 1].body.replace('**Admin Reply:**\n\n', '').trim();
          }
        } catch (_) {}

        return {
          id: String(i.number),
          ghNumber: i.number,
          subject: (i.title || '').replace(/^\[Support\]\s*/, ''),
          status,
          createdAt: i.created_at,
          ghUrl: i.html_url,
          adminReply
        };
      }));

      // Update local cache
      store.set('supportTickets', tickets);
      return tickets;
    } catch (_) {
      // Fall back to local cache
    }
  }

  // For admin, fetch ALL support tickets
  if (isAdmin() && token) {
    try {
      const issues = await ghAPI('GET', `/repos/${GITHUB_REPO}/issues?labels=support&state=all&per_page=100&sort=created&direction=desc`);
      return issues.map(i => {
        let status = 'open';
        if (i.state === 'closed') status = 'resolved';
        if (i.labels.some(l => l.name === 'in-progress')) status = 'in-progress';
        if (i.labels.some(l => l.name === 'resolved')) status = 'resolved';
        if (i.labels.some(l => l.name === 'wont-fix')) status = 'closed';

        // Extract email from body
        const emailMatch = (i.body || '').match(/\*\*Email:\*\*\s*(.+)/);
        const nameMatch = (i.body || '').match(/\*\*User:\*\*\s*(.+)/);

        return {
          id: String(i.number),
          ghNumber: i.number,
          subject: (i.title || '').replace(/^\[Support\]\s*/, ''),
          description: (i.body || '').split('\n---')[0].trim(),
          email: emailMatch ? emailMatch[1].trim() : '',
          userName: nameMatch ? nameMatch[1].trim() : '',
          status,
          createdAt: i.created_at,
          ghUrl: i.html_url
        };
      });
    } catch (_) {}
  }

  return store.get('supportTickets') || [];
});

function extractAdminReply(body) {
  if (!body) return null;
  const match = body.match(/\*\*Admin Reply:\*\*\s*([\s\S]+?)(?:\n---|$)/);
  return match ? match[1].trim() : null;
}

ipcMain.handle('update-ticket-status', async (_ev, { ticketId, status, reply }) => {
  if (!isAdmin()) return { error: 'Not authorized' };

  const token = getGitHubToken();
  if (!token) return { error: 'Support system not configured.' };

  const issueNumber = parseInt(ticketId);
  if (!issueNumber) return { error: 'Invalid ticket ID.' };

  try {
    // Update labels based on status
    const labelsToSet = ['support'];
    let ghState = 'open';

    if (status === 'in-progress') labelsToSet.push('in-progress');
    if (status === 'resolved') { labelsToSet.push('resolved'); ghState = 'closed'; }
    if (status === 'closed' || status === 'wont-fix') { labelsToSet.push('wont-fix'); ghState = 'closed'; }

    await ghAPI('PATCH', `/repos/${GITHUB_REPO}/issues/${issueNumber}`, {
      state: ghState,
      labels: labelsToSet
    });

    // Add admin reply as a comment if provided
    if (reply && reply.trim()) {
      await ghAPI('POST', `/repos/${GITHUB_REPO}/issues/${issueNumber}/comments`, {
        body: `**Admin Reply:**\n\n${reply.trim()}`
      });
    }

    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-ticket-comments', async (_ev, issueNumber) => {
  const token = getGitHubToken();
  if (!token || !issueNumber) return [];
  try {
    const comments = await ghAPI('GET', `/repos/${GITHUB_REPO}/issues/${issueNumber}/comments?per_page=50`);
    return comments.map(c => ({
      id: c.id,
      body: c.body || '',
      author: c.user?.login || 'unknown',
      createdAt: c.created_at,
      isAdmin: (c.body || '').includes('**Admin Reply:**')
    }));
  } catch (_) {
    return [];
  }
});

/* ─────────────────── Process Disguise (Lockdown Mode) ─────────────────── */

function applyProcessDisguise() {
  if (!isLockdown()) return;
  // Disguise process title so lockdown browsers don't recognize "SilentGPT" or "Electron"
  // Use names that look like legitimate OS services
  if (process.platform === 'darwin') {
    try { process.title = 'com.apple.accessibility.AXVisualSupportAgent'; } catch (_) {}
    try { app.setName('AXVisualSupportAgent'); } catch (_) {}
  } else if (process.platform === 'win32') {
    try { process.title = 'SecurityHealthService'; } catch (_) {}
    try { app.setName('SecurityHealthService'); } catch (_) {}
  } else {
    try { process.title = 'systemd-resolved'; } catch (_) {}
  }
}

/* ─────────────────── Watchdog / Respawner ─────────────────── */
// Launches a tiny background process that monitors this app and restarts it if killed
let watchdogProc = null;

function startWatchdog() {
  if (watchdogProc) return;
  const appPath = app.getPath('exe');
  const pid = process.pid;
  // In lockdown mode, wait longer before respawn (5s) so SEB/lockdown browsers
  // finish their process scan before SilentGPT reappears
  const delay = isLockdown() ? 5 : 1;

  if (process.platform === 'darwin') {
    const appBundle = appPath.replace(/\/Contents\/MacOS\/.*$/, '');
    const script = `while kill -0 ${pid} 2>/dev/null; do sleep 2; done; sleep ${delay}; open "${appBundle}"`;
    watchdogProc = exec(`bash -c '${script}'`, { detached: true, stdio: 'ignore' });
    if (watchdogProc.unref) watchdogProc.unref();
  } else if (process.platform === 'win32') {
    // Use cmd.exe + ping-based wait (stealthier than powershell — looks like normal networking)
    const escaped = appPath.replace(/"/g, '""');
    const cmd = `cmd.exe /c "title SvcHost & :loop & tasklist /fi "PID eq ${pid}" 2>nul | find "${pid}" >nul & if errorlevel 1 (ping -n ${delay + 3} 127.0.0.1 >nul & start "" "${escaped}") else (ping -n 3 127.0.0.1 >nul & goto loop)"`;
    watchdogProc = exec(cmd, { detached: true, stdio: 'ignore', windowsHide: true });
    if (watchdogProc.unref) watchdogProc.unref();
  }
}

function stopWatchdog() {
  if (watchdogProc) {
    try { watchdogProc.kill(); } catch (_) {}
    watchdogProc = null;
  }
}

/* ─────────────────── System-Level Persistence (Lockdown Mode) ─────────────────── */
// Uses OS-level service managers to keep SilentGPT alive — survives even SIGKILL (kill -9)
// macOS: launchd LaunchAgent (PID 1 manages restarts — nothing can stop it)
// Windows: Scheduled Task with auto-restart on failure

function installPersistence() {
  if (!isLockdown()) return;

  if (process.platform === 'darwin') {
    try {
      const appBundle = app.getPath('exe').replace(/\/Contents\/MacOS\/.*$/, '');
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.silentgpt.persistence.plist');
      const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
      if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true });
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.silentgpt.persistence</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>${appBundle}</string>
  </array>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>`;
      fs.writeFileSync(plistPath, plist);
      exec(`launchctl unload "${plistPath}" 2>/dev/null; launchctl load "${plistPath}"`, { timeout: 5000 });
      console.log('[PERSISTENCE] macOS LaunchAgent installed — launchd will auto-restart SilentGPT');
    } catch (err) { console.warn('[PERSISTENCE] Failed to install LaunchAgent:', err.message); }
  }

  if (process.platform === 'win32') {
    try {
      const appPath = app.getPath('exe');
      const appDir = path.dirname(appPath);

      // 1. Write a hidden VBS watchdog script that Respondus won't detect
      //    VBS runs as wscript.exe (a legit Windows process), not PowerShell
      const vbsPath = path.join(appDir, 'svc.vbs');
      const vbsContent = `On Error Resume Next
Set WshShell = CreateObject("WScript.Shell")
Dim exePath
exePath = "${appPath.replace(/\\/g, '\\\\').replace(/"/g, '""')}"
Do
  WScript.Sleep 5000
  Err.Clear
  Set objWMI = GetObject("winmgmts:\\\\.\\root\\cimv2")
  If Err.Number <> 0 Then
    Err.Clear
    WScript.Sleep 10000
  Else
    Set procs = objWMI.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ExecutablePath='" & Replace(exePath, "\\", "\\\\") & "'")
    If Err.Number = 0 Then
      If procs.Count = 0 Then
        WScript.Sleep 3000
        WshShell.Run """" & exePath & """", 0, False
      End If
      Set procs = Nothing
    End If
    Err.Clear
    Set objWMI = Nothing
  End If
Loop`;
      fs.writeFileSync(vbsPath, vbsContent);

      // 2. Launch the VBS watchdog hidden (wscript.exe — invisible, not flagged)
      exec(`wscript.exe "${vbsPath}"`, { detached: true, stdio: 'ignore', windowsHide: true });

      // 3. Also create a Scheduled Task as backup — runs the VBS monitor at logon
      //    AND runs it every 5 minutes so even if watchdog dies, task re-launches it
      const taskPs = `
$vbsAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${vbsPath.replace(/'/g, "''")}"'
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 365)
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 365)
Register-ScheduledTask -TaskName 'SilentGPTPersistence' -Action $vbsAction -Trigger @($triggerLogon, $triggerRepeat) -Settings $settings -Force -Description 'System Health Monitor' 2>$null`;
      exec(`powershell -WindowStyle Hidden -Command "${taskPs.replace(/\n/g, '; ')}"`, { timeout: 10000, windowsHide: true });

      console.log('[PERSISTENCE] Windows VBS watchdog + Scheduled Task installed');
    } catch (err) { console.warn('[PERSISTENCE] Failed to install Windows persistence:', err.message); }
  }
}

function removePersistence() {
  if (process.platform === 'darwin') {
    try {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.silentgpt.persistence.plist');
      exec(`launchctl unload "${plistPath}" 2>/dev/null`, { timeout: 5000 });
      try { fs.unlinkSync(plistPath); } catch (_) {}
      console.log('[PERSISTENCE] macOS LaunchAgent removed');
    } catch (_) {}
  }
  if (process.platform === 'win32') {
    try {
      // Kill any running VBS watchdog processes
      exec('taskkill /f /im wscript.exe 2>nul', { timeout: 5000, windowsHide: true });
    } catch (_) {}
    try {
      // Remove the VBS script file
      const vbsPath = path.join(path.dirname(app.getPath('exe')), 'svc.vbs');
      if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath);
    } catch (_) {}
    try {
      exec('schtasks /delete /tn "SilentGPTPersistence" /f', { timeout: 5000, windowsHide: true });
      console.log('[PERSISTENCE] Windows persistence fully removed');
    } catch (_) {}
  }
}

/* ─────────────────── Window Close Resistance (Windows) ─────────────────── */
// On Windows, prevent external processes from closing our overlay window
function applyCloseResistance(win) {
  if (!win) return;
  // Intercept close events — only allow if triggered by our own code
  let allowClose = false;
  win._silentgptAllowClose = () => { allowClose = true; };
  win.on('close', (e) => {
    if (!allowClose) {
      e.preventDefault(); // Block external close attempts (lockdown browsers)
      // Re-assert always-on-top after close attempt
      applyOverlayLevel();
    }
  });
  // Block minimize attempts from external processes (Respondus tries this)
  win.on('minimize', () => {
    if (overlayUp && !allowClose) {
      setTimeout(() => {
        try { if (win && !win.isDestroyed()) { win.restore(); applyOverlayLevel(); } } catch (_) {}
      }, 50);
    }
  });
  // Block hide attempts — if overlay should be up, immediately re-show
  win.on('hide', () => {
    if (overlayUp && !allowClose) {
      setTimeout(() => {
        try { if (win && !win.isDestroyed()) { win.showInactive(); applyOverlayLevel(); } } catch (_) {}
      }, 50);
    }
  });
  // Block blur — if lockdown browser steals focus, reclaim it
  win.on('blur', () => {
    if (overlayUp && isLockdown()) {
      setTimeout(() => {
        try { if (win && !win.isDestroyed()) { win.moveTop(); applyOverlayLevel(); } } catch (_) {}
      }, 100);
    }
  });
}

/* ─────────────────── App Lifecycle ─────────────────── */

function setupMediaPermissions() {
  try {
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'media' || permission === 'display-capture');
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media' || permission === 'display-capture');
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources[0]) { callback({}); return; }
          callback(process.platform === 'win32' ? { video: sources[0], audio: 'loopback' } : { video: sources[0] });
        })
        .catch(() => callback({}));
    });
  } catch (_) {}
}

app.whenReady().then(async () => {
  app.setAppUserModelId('net.trysilentgpt.app');
  setupMediaPermissions();
  if (process.platform === 'darwin') {
    try { app.dock?.setIcon(getAppIconImage()); } catch (_) {}
  }
  // Initialize store AFTER app is ready so getPath('userData') works
  initStore();
  initAnalytics();
  applyProcessDisguise(); // Disguise process name if lockdown mode is active
  initKernelShield();    // Load Windows kernel driver (if available)
  if (isLockdown()) activateKernelStealth(); // Kernel-level hide + anti-kill
  startWatchdog(); // Launch background respawner so SilentGPT survives being killed
  installPersistence(); // Install system-level auto-restart (launchd/scheduled task)
  await checkSubscriptionStatus(true); // Verify Stripe subscription on every launch — blocks until resolved

  // Tray is always available (for Quit, Settings, etc.)
  makeTray();

  // Create overlay and bind hotkeys for free Lite and paid Pro users.
  if (isAppUnlocked()) {
    if (isLockdown()) {
      // In lockdown mode: delay overlay creation so SEB/lockdown browsers finish
      // their startup process scan before we create any windows.
      // Hotkeys are bound immediately so user can trigger overlay when ready.
      bindKeys();
      setTimeout(() => { if (!overlayWin) makeOverlay(); }, 3000);
    } else {
      makeOverlay();
      bindKeys();
    }
  }

  // Start screen capture detection — hides overlay during screen recording/sharing
  initScreenCaptureDetection();

  // Flow: Auth → Welcome Tour → Lite/Pro choice → App
  if (!store.get('authDone')) {
    showAuth();
  } else if (!store.get('onboardingDone')) {
    showWelcome();
  } else if (!isAppUnlocked()) {
    showActivate();
  } else {
    if (process.platform === 'darwin') app.dock?.hide();
    showMainMenuIfReady();
  }

  // Periodic re-validation: check Stripe subscription every 10 minutes
  setInterval(async () => {
    try {
      await checkSubscriptionStatus(true); // force=true bypasses cooldown
      // If a Pro subscription was revoked, downgrade to Lite and disable Pro-only stealth features.
      if (!hasProAccess() && !ADMIN_KEYS.includes(store.get('licenseKey'))) {
        PRO_ONLY_SETTING_KEYS.forEach((key) => store.set(key, false));
        if (overlayWin) overlayWin.webContents.send('load-settings', sanitizedSettings());
      }
    } catch (_) {}
  }, 10 * 60 * 1000);

  app.on('activate', () => { if (isAppUnlocked() && !overlayWin) makeOverlay(); });
});

app.on('window-all-closed', () => {});
app.on('will-quit', () => { stopWatchdog(); removePersistence(); globalShortcut.unregisterAll(); cleanupScreenCaptureDetection(); });

// Resist SIGTERM from lockdown browsers — they send terminate signals to kill unauthorized apps
// In lockdown mode, ignore SIGTERM entirely (user must use Force Close to quit)
process.on('SIGTERM', () => {
  if (isLockdown()) {
    console.log('[LOCKDOWN] Blocked SIGTERM from external process');
    return; // Swallow the signal — don't exit
  }
  app.quit();
});
process.on('SIGHUP', () => {
  if (isLockdown()) {
    console.log('[LOCKDOWN] Blocked SIGHUP from external process');
    return;
  }
});

process.on('unhandledRejection',  r => console.warn('Unhandled rejection:', r?.message || r));
process.on('uncaughtException', err => console.error('Uncaught exception:', err.message));

// Dock hide moved into whenReady — see showAuth/showWelcome for temporary show/hide
