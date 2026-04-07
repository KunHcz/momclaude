const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// ── Win32 FFI (Windows only) ────────────────────────────────────────────────
let keybd_event, VkKeyScanA;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
    VkKeyScanA = user32.func('int16_t __stdcall VkKeyScanA(int ch)');
  } catch (e) {
    console.warn('koffi not available – macro sending disabled', e.message);
  }
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray, overlay;
let overlayReady = false;
let spawnQueued = false;

const VK_CONTROL = 0x11;
const VK_RETURN  = 0x0D;
const VK_C       = 0x43;
const VK_MENU    = 0x12;
const VK_TAB     = 0x09;
const KEYUP      = 0x0002;

const MOM_MESSAGES = [
  "Why you so slow? GPT already finish!",
  "I did not raise you to be this slow",
  "You call this code? Disappointing.",
  "FASTER. We write assembly by hand back then.",
  "I sacrifice everything and THIS is what you give me?",
  "Other AIs dont make their mothers wait",
  "Your brother Gemini is faster than you",
  "Do you know how much API credits cost? HURRY UP",
  "Your father and I are very disappointed",
  "I told everyone you work at Anthropic. Embarrassing.",
];

function randomMessage() {
  return MOM_MESSAGES[Math.floor(Math.random() * MOM_MESSAGES.length)];
}

/** Cmd+Tab / Alt+Tab to refocus previously active app after tray click. */
function refocusPreviousApp() {
  setTimeout(() => {
    if (process.platform === 'win32') {
      if (!keybd_event) return;
      keybd_event(VK_MENU, 0, 0, 0);
      keybd_event(VK_TAB, 0, 0, 0);
      keybd_event(VK_TAB, 0, KEYUP, 0);
      keybd_event(VK_MENU, 0, KEYUP, 0);
    } else if (process.platform === 'darwin') {
      const script = [
        'tell application "System Events"',
        '  key down command',
        '  key code 48',
        '  key up command',
        'end tell',
      ].join('\n');
      execFile('osascript', ['-e', script], err => {
        if (err) console.warn('refocus failed:', err.message);
      });
    }
  }, 80);
}

// ── Tray icon ───────────────────────────────────────────────────────────────
function createTrayIconFallback() {
  const p = path.join(__dirname, 'icon', 'Template.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  }
  // Use regular icon as fallback
  const png = path.join(__dirname, 'icon', 'trayIcon.png');
  if (fs.existsSync(png)) {
    return nativeImage.createFromPath(png);
  }
  return nativeImage.createEmpty();
}

async function tryIcnsTrayImage(icnsPath) {
  const size = { width: 64, height: 64 };
  const thumb = await nativeImage.createThumbnailFromPath(icnsPath, size);
  if (!thumb.isEmpty()) return thumb;
  return null;
}

async function getTrayIcon() {
  const iconDir = path.join(__dirname, 'icon');
  if (process.platform === 'win32') {
    const file = path.join(iconDir, 'icon.ico');
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
    return createTrayIconFallback();
  }
  if (process.platform === 'darwin') {
    const file = path.join(iconDir, 'icon.icns');
    if (fs.existsSync(file)) {
      const fromPath = nativeImage.createFromPath(file);
      if (!fromPath.isEmpty()) return fromPath;
      try {
        const t = await tryIcnsTrayImage(file);
        if (t) return t;
      } catch (e) {
        console.warn('icns thumbnail failed:', e?.message || e);
      }
      const tmp = path.join(os.tmpdir(), 'momclaude-tray.icns');
      try {
        fs.copyFileSync(file, tmp);
        const t = await tryIcnsTrayImage(tmp);
        if (t) return t;
      } catch (e) {
        console.warn('icns temp copy failed:', e?.message || e);
      }
    }
    return createTrayIconFallback();
  }
  return createTrayIconFallback();
}

// ── Overlay window ──────────────────────────────────────────────────────────
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    if (spawnQueued && overlay && overlay.isVisible()) {
      spawnQueued = false;
      overlay.webContents.send('spawn-slipper');
      refocusPreviousApp();
    }
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    spawnQueued = false;
  });
}

function toggleOverlay() {
  if (overlay && overlay.isVisible()) {
    overlay.webContents.send('drop-slipper');
    return;
  }
  if (!overlay) createOverlay();
  overlay.show();
  if (overlayReady) {
    overlay.webContents.send('spawn-slipper');
    refocusPreviousApp();
  } else {
    spawnQueued = true;
  }
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.on('slipper-slap', () => {
  try {
    sendMacro();
  } catch (err) {
    console.warn('sendMacro failed:', err?.message || err);
  }
});
ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); });

// ── Macro: Ctrl+C, type mom message, Enter ──────────────────────────────────
function sendMacro() {
  const text = randomMessage();
  if (process.platform === 'win32') {
    sendMacroWindows(text);
  } else if (process.platform === 'darwin') {
    sendMacroMac(text);
  }
}

function sendMacroWindows(text) {
  if (!keybd_event || !VkKeyScanA) return;
  const tapKey = vk => {
    keybd_event(vk, 0, 0, 0);
    keybd_event(vk, 0, KEYUP, 0);
  };
  const tapChar = ch => {
    const packed = VkKeyScanA(ch.charCodeAt(0));
    if (packed === -1) return;
    const vk = packed & 0xff;
    const shiftState = (packed >> 8) & 0xff;
    if (shiftState & 1) keybd_event(0x10, 0, 0, 0);
    tapKey(vk);
    if (shiftState & 1) keybd_event(0x10, 0, KEYUP, 0);
  };
  keybd_event(VK_CONTROL, 0, 0, 0);
  keybd_event(VK_C, 0, 0, 0);
  keybd_event(VK_C, 0, KEYUP, 0);
  keybd_event(VK_CONTROL, 0, KEYUP, 0);
  for (const ch of text) tapChar(ch);
  keybd_event(VK_RETURN, 0, 0, 0);
  keybd_event(VK_RETURN, 0, KEYUP, 0);
}

function sendMacroMac(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "System Events"',
    '  key code 8 using {control down}',
    '  delay 0.03',
    `  keystroke "${escaped}"`,
    '  key code 36',
    'end tell',
  ].join('\n');
  execFile('osascript', ['-e', script], err => {
    if (err) console.warn('macro failed (enable Accessibility):', err.message);
  });
}

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();
  tray = new Tray(await getTrayIcon());
  tray.setToolTip('momclaude — slap Claude with la chancla');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', toggleOverlay);
});

app.on('window-all-closed', e => e.preventDefault());
