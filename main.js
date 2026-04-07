const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require("electron");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.disableHardwareAcceleration();

const path = require("path");
const { dialog } = require("electron");
const fetch = require("node-fetch");
const FormData = require("form-data");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

/* =========================
   AUTO-UPDATER CONFIG
========================= */
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on("checking-for-update", () => console.log("Checking for update..."));
autoUpdater.on("update-available", (info) => console.log("Update available:", info.version));
autoUpdater.on("update-not-available", () => console.log("No updates available"));
autoUpdater.on("error", (err) => console.error("Update error:", err.message));
autoUpdater.on("download-progress", (p) => console.log(`Downloaded ${Math.round(p.percent)}%`));
autoUpdater.on("update-downloaded", (info) => {
    console.log("Update downloaded, will install on quit:", info.version);
});

let win;
let overlayWindow;
let timer = null;
let currentAuth = null;
let splash;
let overlayHideTimer = null;
let credentialsPath;


function saveCredentials(data) {
    try {
        fs.writeFileSync(credentialsPath, JSON.stringify(data));
    } catch (err) {
        console.error("Failed to save credentials:", err);
    }
}

function getSavedCredentials() {
    try {
        if (fs.existsSync(credentialsPath)) {
            return JSON.parse(fs.readFileSync(credentialsPath));
        }
    } catch (err) {
        console.error("Failed to read credentials:", err);
    }
    return null;
}

function clearCredentials() {
    try {
        if (fs.existsSync(credentialsPath)) {
            fs.unlinkSync(credentialsPath);
        }
    } catch (err) {
        console.error("Failed to clear credentials:", err);
    }
}

ipcMain.handle("auth:save", (event, data) => {
    saveCredentials(data);
    return { ok: true };
});

ipcMain.handle("auth:get", () => {
    return getSavedCredentials();
});

ipcMain.handle("auth:clear", () => {
    clearCredentials();
    return { ok: true };
});

/* =========================
   CREATE MAIN WINDOW
========================= */
function createWindow() {

    /* =========================
       SPLASH WINDOW
    ========================= */
    splash = new BrowserWindow({
        width: 400,
        height: 300,
        frame: false,
        alwaysOnTop: true,
        transparent: false,
        backgroundColor: "#1e1e2f",
        resizable: false,
        show: true
    });

    splash.loadFile(path.join(__dirname, "splash.html"));

    /* =========================
       MAIN WINDOW (HIDDEN)
    ========================= */
    win = new BrowserWindow({
        width: 1300,
        height: 800,
        show: false,
        backgroundColor: "#1e1e2f",
        icon: path.join(__dirname, "assets", "icon.ico"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            partition: "persist:main"
        }
    });

    win.webContents.on("render-process-gone", (event, details) => {
        console.error("Renderer crashed:", details);
        if (details.reason !== "clean-exit") {
            console.log("Reloading window after crash...");
            win.reload();
        }
    });

    win.webContents.on("unresponsive", () => {
        console.error("Window unresponsive — reloading...");
        win.reload();
    });


    let isQuitting = false;

    win.on("close", async (e) => {
        if (isQuitting) return;

        if (!timer) {
            isQuitting = true;
            app.quit();
            return;
        }

        e.preventDefault();

        const choice = await dialog.showMessageBox(win, {
            type: "warning",
            buttons: ["Cancel", "Yes, Exit"],
            defaultId: 0,
            cancelId: 0,
            title: "Confirm Exit",
            message: "You are currently working.",
            detail:
                "If you close the app, you will be clocked out and work tracking will stop.\n\nAre you sure you want to exit?"
        });

        if (choice.response !== 1) return;

        isQuitting = true;
        stopTracking();
        await clockOutIfNeeded(win);

        try {
            await win.webContents.executeJavaScript(`
      localStorage.removeItem("token");
      localStorage.removeItem("user");
    `);
        } catch (err) { }

        app.quit();
    });

    win.removeMenu();

    const indexPath = app.isPackaged
        ? path.join(__dirname, "build", "index.html")
        : path.join(__dirname, "../build/index.html");

    win.loadFile(indexPath);

    win.once("ready-to-show", () => {
        if (splash) {
            splash.destroy();
            splash = null;
        }
        win.show();
    });

    createOverlayWindow();
}

/* =========================
   CREATE OVERLAY WINDOW
========================= */
function createOverlayWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    overlayWindow = new BrowserWindow({
        width: 280,
        height: 210,
        x: width - 300,
        y: height - 230,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: false,
        show: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true
        }
    });

    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.setAlwaysOnTop(true, "floating");
    overlayWindow.loadFile(path.join(__dirname, "overlay.html"));
}

/* =========================
   APP READY
========================= */
app.whenReady().then(() => {
    credentialsPath = path.join(app.getPath("userData"), "auth.json");

    // Auto-launch on Windows startup
    app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: false,
        path: app.getPath("exe")
    });

    createWindow();

    // Check for updates 5 seconds after launch (don't block startup)
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => {
            console.error("Update check failed:", err.message);
        });
    }, 5000);

    // Then check every 2 hours while running
    setInterval(() => {
        autoUpdater.checkForUpdates().catch(err => {
            console.error("Update check failed:", err.message);
        });
    }, 2 * 60 * 60 * 1000);
});

/* =========================
   CAPTURE SCREEN
========================= */
async function captureScreen() {
    const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1366, height: 768 }
    });

    if (!sources.length) return null;

    const image = sources[0].thumbnail;
    await new Promise(resolve => setTimeout(resolve, 120));
    const jpegBuffer = image.toJPEG(65);

    return {
        buffer: jpegBuffer,
        base64: jpegBuffer.toString("base64")
    };
}

/* =========================
   UPLOAD TO BACKEND
========================= */
async function uploadScreenshot(auth, buffer) {
    try {
        if (!auth?.apiBase || !auth?.token) return;

        const form = new FormData();
        form.append("screenshot", buffer, {
            filename: `ss_${Date.now()}.jpg`,
            contentType: "image/jpeg"
        });
        form.append("capturedAt", new Date().toISOString());

        const res = await fetch(`${auth.apiBase}/api/screenshots`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${auth.token}`,
                ...form.getHeaders()
            },
            body: form
        });

        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            console.error("Screenshot upload failed:", res.status, txt);
        } else {
            console.log("Screenshot uploaded");
        }
    } catch (err) {
        console.error("Upload error:", err.message);
    }
}

function stopTracking() {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    try {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.hide();
        }
    } catch (e) { }
}

async function clockOutIfNeeded(win) {
    try {
        const token = await win.webContents.executeJavaScript(
            `localStorage.getItem("token")`
        );

        if (!token) return { didClockOut: false, reason: "no_token" };

        let apiBase = currentAuth?.apiBase;
        if (!apiBase) {
            apiBase = await win.webContents.executeJavaScript(
                `localStorage.getItem("apiBase")`
            );
        }

        if (!apiBase) {
            return { didClockOut: false, reason: "no_apiBase" };
        }

        const res = await fetch(`${apiBase}/api/employee/attendance/clock-out`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` }
        });

        if (res.ok) return { didClockOut: true, reason: "ok" };

        if ([400, 401, 403, 404, 409].includes(res.status)) {
            return { didClockOut: false, reason: `already_or_not_allowed_${res.status}` };
        }

        const txt = await res.text().catch(() => "");
        console.error("Clock-out unexpected error:", res.status, txt);
        return { didClockOut: false, reason: `unexpected_${res.status}` };
    } catch (err) {
        console.error("Clock-out on close failed:", err.message);
        return { didClockOut: false, reason: "exception" };
    }
}

/* =========================
   START TRACKING
========================= */
ipcMain.handle("ss:start", async (event, payload) => {
    const { apiBase, token } = payload;

    stopTracking();
    currentAuth = { apiBase, token };

    const MIN_DELAY = 50 * 60 * 1000;   // 50 minutes
    const MAX_DELAY = 70 * 60 * 1000;   // 70 minutes

    const scheduleNext = () => {
        const randomDelay =
            Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY)) + MIN_DELAY;

        console.log(`Next screenshot in ${Math.round(randomDelay / 1000)} seconds`);

        timer = setTimeout(async () => {
            try {
                const result = await captureScreen();
                if (!result) {
                    scheduleNext();
                    return;
                }

                if (overlayWindow && !overlayWindow.isDestroyed()) {
                    overlayWindow.webContents.send("overlay-screenshot", result.base64);

                    if (!overlayWindow.isVisible()) {
                        overlayWindow.showInactive();
                    }
                    if (overlayHideTimer) {
                        clearTimeout(overlayHideTimer);
                    }

                    overlayHideTimer = setTimeout(() => {
                        if (overlayWindow && !overlayWindow.isDestroyed()) {
                            overlayWindow.hide();
                            overlayWindow.setIgnoreMouseEvents(true, { forward: true });
                        }
                    }, 2000);
                }
                uploadScreenshot(currentAuth, result.buffer)
                    .catch(err => console.error("Upload error:", err));

            } catch (err) {
                console.error("Screenshot error:", err.message);
            }

            scheduleNext();
        }, randomDelay);
    };

    scheduleNext();
    return { ok: true };
});

/* =========================
   STOP TRACKING
========================= */
ipcMain.handle("ss:stop", async () => {
    stopTracking();
    return { ok: true };
});

/* =========================
   APP LIFECYCLE
========================= */
app.on("window-all-closed", () => {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    if (process.platform !== "darwin") {
        app.quit();
    }
});