// index.cjs —— 主进程入口：让远程控制小窗的可见卡片能拖到屏幕左侧。
//
// 播放器在 electron/main.cjs 里给这个窗口挂了一条 will-move（keepRemoteControlCoverOnScreen），
// 窗口左边缘越出屏幕时它会 preventDefault 并把窗口挪回去。这一条模组完全不碰：
//   - 不清空这个事件上的监听，别人的原样留着；
//   - 只在它后面追加一条自己的，等它处理完，把窗口放回用户拖到的位置；
//   - 停用时只摘掉自己这一条，播放器的规则从头到尾没被动过，也就没有什么要"还原"。
// 它那句 preventDefault 已经让系统不去移动窗口了，所以后面这条 setContentBounds 就是最终位置。
'use strict';

const { app, BrowserWindow, screen } = require('electron');

/** 播放器给远程控制窗口的标题（electron/main.cjs 的 REMOTE_CONTROL_WINDOW_TITLE）。 */
const REMOTE_WINDOW_TITLE = 'Folia Remote';
/** 默认允许窗口比播放器原本允许的位置再往左多少像素。 */
const DEFAULT_OVERHANG = 178;
const MAX_OVERHANG = 420;

const clampOverhang = (value) => {
    const overhang = Number(value);
    if (!Number.isFinite(overhang)) return DEFAULT_OVERHANG;
    return Math.min(MAX_OVERHANG, Math.max(0, Math.round(overhang)));
};

const isRemoteWindow = (win) => {
    try {
        if (!win || win.isDestroyed()) return false;
        return win.getTitle() === REMOTE_WINDOW_TITLE;
    } catch {
        return false;
    }
};

module.exports = function activate(api) {
    if (process.platform !== 'win32') {
        // 播放器只在 Windows 上挂那条 will-move；别处窗口本来就能拖出屏幕。
        api.log.info('[remote-window-edge] nothing to do: the host clamps the drag on Windows only');
        return () => {};
    }

    const state = { enabled: true, overhang: DEFAULT_OVERHANG };
    /** 窗口 → 我们挂上去的那一个监听，只用来摘掉自己这一份。 */
    const hooks = new Map();
    let disposed = false;

    /*
     * 播放器会让窗口停下来的位置就是它选中的那块屏的左边缘（clampRemoteControlWindowX 的
     * home.x），多屏时选重叠最多的那块——screen.getDisplayMatching 是同一件事的官方 API，
     * 所以这里不用照抄它的算法，也不用知道窗口和卡片有多宽。
     *
     * 窗口没越过屏幕左边缘时播放器根本不拦，这里也就不做事：模组只放宽它拦的那一种情形，
     * 别的方向、别的窗口一概不碰。
     */
    const onWillMove = (win, event, newBounds) => {
        if (!state.enabled || disposed || !app.isReady()) return;
        try {
            const target = Number(newBounds?.x);
            if (!Number.isFinite(target)) return;
            const area = screen.getDisplayMatching({
                x: Math.round(target),
                y: Math.round(Number(newBounds?.y) || 0),
                width: Math.max(1, Math.round(Number(newBounds?.width) || 1)),
                height: Math.max(1, Math.round(Number(newBounds?.height) || 1)),
            });
            const hostStop = area.bounds.x;
            if (target >= hostStop) return;
            const floor = hostStop - state.overhang;
            const next = Math.max(target, floor);
            if (next === hostStop) return;
            const y = Number(newBounds?.y);
            // setContentBounds, not setPosition: on a display scaled to 150 % the latter leaves the
            // window a pixel wider and taller every time it is called, and the ring it grows is
            // invisible but still window — it swallows clicks around the card. The content size is
            // the one the page is laid out to, so that is what gets held.
            const [width, height] = win.getContentSize();
            win.setContentBounds({
                x: Math.round(next),
                y: Math.round(Number.isFinite(y) ? y : win.getBounds().y),
                width,
                height,
            });
        } catch (error) {
            api.log.warn('[remote-window-edge] will-move handler failed', error);
        }
    };

    /* 先摘掉自己那份再加回去：位置永远排在已有监听之后，别人的一条都不动。 */
    const attach = (win) => {
        if (disposed || !isRemoteWindow(win)) return;
        const previous = hooks.get(win);
        if (previous) win.removeListener('will-move', previous);
        const handler = (event, newBounds) => onWillMove(win, event, newBounds);
        win.on('will-move', handler);
        hooks.set(win, handler);
    };

    const detach = (win) => {
        const handler = hooks.get(win);
        if (!handler) return;
        hooks.delete(win);
        if (!win.isDestroyed()) win.removeListener('will-move', handler);
    };

    const detail = () => ({ enabled: state.enabled, overhang: state.overhang });

    const watch = (win) => {
        if (disposed || !isRemoteWindow(win)) return;
        // 播放器是 BrowserWindow 构造返回之后才挂自己的监听，browser-window-created 那一刻
        // 还轮不到它：等这一轮同步代码跑完再接，之后各处再补一次，位置始终排在最后。
        setImmediate(() => {
            if (disposed) return;
            attach(win);
            api.log.info('[remote-window-edge] watching the drag limit of the remote window', detail());
        });
        win.once('ready-to-show', () => attach(win));
        win.once('closed', () => hooks.delete(win));
    };

    const watchExisting = () => {
        for (const win of BrowserWindow.getAllWindows()) watch(win);
    };

    const onWindowCreated = (event, win) => watch(win);

    const applySettings = (next) => {
        if (!next || typeof next !== 'object') return;
        if (typeof next.enabled === 'boolean') state.enabled = next.enabled;
        if (next.overhang !== undefined) state.overhang = clampOverhang(next.overhang);
    };

    const readSettings = async () => {
        try {
            const [enabled, overhang] = await Promise.all([
                api.storage.get('enabled'),
                api.storage.get('overhang'),
            ]);
            applySettings({ enabled, overhang });
        } catch (error) {
            api.log.warn('[remote-window-edge] could not read the saved settings', error);
        }
    };

    api.rpc.handle('settings', (next) => {
        applySettings(next);
        return detail();
    });
    api.rpc.handle('status', () => ({
        ...detail(),
        maxOverhang: MAX_OVERHANG,
        attached: hooks.size,
        remoteWindows: BrowserWindow.getAllWindows().filter(isRemoteWindow).length,
    }));

    app.on('browser-window-created', onWindowCreated);
    if (app.isReady()) {
        watchExisting();
    } else {
        app.once('ready', watchExisting);
    }
    void readSettings();

    return () => {
        disposed = true;
        app.removeListener('browser-window-created', onWindowCreated);
        app.removeListener('ready', watchExisting);
        // 只摘掉自己这一条；播放器的 will-move 从头到尾没被碰过。
        for (const win of Array.from(hooks.keys())) detach(win);
    };
};
