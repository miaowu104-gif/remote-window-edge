// client.mjs —— 主窗口入口：设置分区（开关 + 往左多拖多少）与一条状态命令。
// 值同时写进模组存储与主进程，窗口已经开着、页面还没加载时主进程也能拿到上次的值。

const ENABLED_KEY = 'enabled';
const OVERHANG_KEY = 'overhang';
const DEFAULT_ENABLED = true;
const DEFAULT_OVERHANG = 178;
const MAX_OVERHANG = 420;

/** 导出窗口里 settingsSections 的 handle 没有面板，退回默认值。 */
const readAccess = (section) => section.settings ?? section.params ?? {
    get: () => ({ [ENABLED_KEY]: DEFAULT_ENABLED, [OVERHANG_KEY]: DEFAULT_OVERHANG }),
    subscribe: () => () => {},
};

/** 读出来的值至少要是这两个键的合法类型，别把 undefined 推给主进程。 */
const readSettings = (access) => {
    const values = access.get() ?? {};
    const overhang = Number(values[OVERHANG_KEY]);
    return {
        enabled: values[ENABLED_KEY] !== false,
        overhang: Number.isFinite(overhang) ? overhang : DEFAULT_OVERHANG,
    };
};

export default function activate(folium) {
    const section = folium.registries.settingsSections.register({
        id: 'edge',
        label: { 'zh-CN': '小窗拖边', en: 'Remote window edge' },
        description: {
            'zh-CN': '放歌时小窗看得见的只有右边那张卡片，左边一截完全透明却仍算在窗口里，'
                + '播放器按整个窗口限制拖动，所以小窗拖不到屏幕左侧。这里决定要不要把那条限制放宽。',
            en: 'In use the remote window shows only its card on the right; the strip left of it is '
                + 'transparent but still counts as window, and the player limits dragging by the whole '
                + 'window. This decides whether to relax that limit.',
        },
        settings: [
            {
                key: ENABLED_KEY,
                type: 'boolean',
                label: { 'zh-CN': '启用拖边修复', en: 'Enable the drag fix' },
                description: {
                    'zh-CN': '关闭后小窗恢复成播放器原本的行为：可见卡片停在离屏幕左边缘 178 px 处，'
                        + '往左拖不动。不需要这个修复时关掉它，模组就不再影响窗口的任何移动。',
                    en: 'Off restores the player\'s own behaviour: the visible card stops 178 px away '
                        + 'from the left edge of the screen. Nothing the mod does touches window movement '
                        + 'while this is off.',
                },
                defaultValue: DEFAULT_ENABLED,
            },
            {
                key: OVERHANG_KEY,
                type: 'number',
                label: { 'zh-CN': '额外往左拖出的像素', en: 'Extra drag-out (px)' },
                description: {
                    'zh-CN': '小窗可以比播放器原本允许的位置再往左多少。178 约等于左边那块透明的宽度，'
                        + '拖动时卡片就正好能贴到屏幕左边缘；0 = 完全跟随播放器的规则。',
                    en: 'How much further left than the player allows. 178 is about the width of the '
                        + 'transparent strip, which lets the card reach the screen edge; 0 = follow the '
                        + 'player exactly.',
                },
                defaultValue: DEFAULT_OVERHANG,
                min: 0,
                max: MAX_OVERHANG,
                step: 1,
            },
        ],
    });

    const access = readAccess(section);

    const sync = async () => {
        const settings = readSettings(access);
        try {
            await folium.rpc.call('settings', settings);
        } catch (error) {
            // 导出窗口没有 rpc；主进程也会自己读存储，不碍事。
        }
        try {
            await folium.storage.set(ENABLED_KEY, settings.enabled);
            await folium.storage.set(OVERHANG_KEY, settings.overhang);
        } catch (error) {
            folium.log.warn('[remote-window-edge] could not save the settings', error);
        }
    };

    const off = typeof access.subscribe === 'function' ? access.subscribe(() => { void sync(); }) : null;
    void sync();

    const command = folium.registries.commands.register({
        id: 'status',
        label: { 'zh-CN': '小窗拖边：状态', en: 'Remote window edge: status' },
        description: {
            'zh-CN': '读主进程里生效的开关、像素与小窗数量。',
            en: 'Reads the switch and the extra drag-out in force, and how many remote windows are open.',
        },
        async run() {
            const settings = readSettings(access);
            try {
                const status = await folium.rpc.call('status');
                const on = status.enabled ? '开' : '关';
                return `修复 ${on}，额外往左 ${status.overhang} px（上限 ${status.maxOverhang}），`
                    + `挂上的窗口 ${status.attached} 个，小窗 ${status.remoteWindows} 个`;
            } catch (error) {
                return `修复 ${settings.enabled ? '开' : '关'}，额外往左 ${settings.overhang} px，读不到主进程：${error?.message ?? error}`;
            }
        },
    });

    return () => {
        if (typeof off === 'function') off();
        command.unregister();
        section.unregister();
    };
}
