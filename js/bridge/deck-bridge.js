/* =========================
   WARDOGS DECK BRIDGE

   Connects the calculator to the Tauri shell so a Stream Deck plugin can
   drive it. Publishes the firing solution after every state change and
   applies commands relayed from the local HTTP API. Does nothing when the
   page runs in an ordinary browser.
   ========================= */

/*
 * Direct placement: when the toggle is on, a left click places Artillery
 * and a right click places Target, and the Artillery/Target buttons are
 * disabled. When it is off the upstream behaviour applies unchanged (the
 * buttons pick the point a left click places). Right-drag pans either way.
 * Works in the browser too, so it does not depend on the Tauri shell.
 */
(function () {
    'use strict';

    const canvas = document.getElementById('canvas');
    const modeBox = document.querySelector('.section .mode');

    if (!canvas || !modeBox) {
        return;
    }

    const STORAGE_KEY = 'wardogs-deck-direct-place';
    const RIGHT_BUTTON = 2;
    const DRAG_THRESHOLD_PX = 4;

    const label = document.createElement('label');
    label.className = 'save-artillery-option deck-direct-place';
    label.style.marginTop = '8px';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'directPlace';

    const text = document.createElement('span');
    text.textContent = 'Left click = Artillery, right click = Target';

    label.append(toggle, text);
    modeBox.insertAdjacentElement('afterend', label);

    /* Same effect as clicking the sidebar buttons, usable before bindEvents(). */
    function setMode(mode) {
        S.mode = mode;
        document.getElementById('originMode')?.classList.toggle('active', mode === 'origin');
        document.getElementById('targetMode')?.classList.toggle('active', mode === 'target');
    }

    function apply() {
        const on = toggle.checked;

        modeBox.style.opacity = on ? '0.4' : '';
        modeBox.style.pointerEvents = on ? 'none' : '';

        if (on) {
            setMode('origin');
        }

        try {
            localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
        } catch (_) {
            /* private mode etc.; the toggle still works for this session */
        }
    }

    try {
        toggle.checked = localStorage.getItem(STORAGE_KEY) === '1';
    } catch (_) {
        toggle.checked = false;
    }

    toggle.addEventListener('change', apply);
    apply();

    let downAt = null;

    /*
     * Capture phase so this runs before the upstream mousedown handler,
     * which reads S.mode to decide what a left click places. Undo can
     * restore an old mode, so re-assert Artillery on every left click.
     */
    canvas.addEventListener('mousedown', event => {
        if (toggle.checked && event.button === 0 && S.mode !== 'origin') {
            setMode('origin');
        }

        downAt =
            event.button === RIGHT_BUTTON
                ? { x: event.clientX, y: event.clientY }
                : null;
    }, true);

    canvas.addEventListener('contextmenu', event => {
        const start = downAt;
        downAt = null;

        if (!toggle.checked || !start) {
            return;
        }

        const moved = Math.hypot(
            event.clientX - start.x,
            event.clientY - start.y
        );

        if (moved > DRAG_THRESHOLD_PX) {
            return;
        }

        if (typeof isPointMapLocked === 'function' && isPointMapLocked('target')) {
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const p = toWorld(event.clientX - rect.left, event.clientY - rect.top);

        pushMapToolHistory();

        S.target = { x: p.x, y: p.y };
        clamp(S.target);

        inputs();
    });
})();

(function () {
    'use strict';

    const tauri = window.__TAURI__;

    if (
        !tauri ||
        !tauri.core ||
        typeof tauri.core.invoke !== 'function' ||
        !tauri.event ||
        typeof tauri.event.listen !== 'function'
    ) {
        return;
    }

    const invoke = tauri.core.invoke;
    const listen = tauri.event.listen;

    /*
     * The asset CDN only answers CORS requests for wardogs-artillery.com,
     * so a tile loaded with crossOrigin="anonymous" from the app origin is
     * rejected by the browser. Nothing here reads canvas pixels, so plain
     * (non-CORS) image loads are fine; ignore the attribute inside the app.
     * The pages also carry a no-referrer meta because the CDN blocks
     * requests whose Referer is not the upstream site.
     */
    const crossOriginDescriptor =
        Object.getOwnPropertyDescriptor(
            HTMLImageElement.prototype,
            'crossOrigin'
        );

    if (crossOriginDescriptor?.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'crossOrigin', {
            configurable: true,
            get: crossOriginDescriptor.get,
            set() {}
        });
    }

    let generation = 0;
    let publishScheduled = false;

    /* ---------- state snapshot ---------- */

    function roundCoordinate(value) {
        return Math.round(Number(value) * 100) / 100;
    }

    function pointSnapshot(point) {
        return {
            x: point.x,
            y: point.y,
            xText: formatGameCoordinate(point.x),
            yText: formatGameCoordinate(point.y)
        };
    }

    function buildState() {
        const weapon = WEAPONS[S.weapon] || null;

        const dx = S.target.x - S.origin.x;
        const dy = S.target.y - S.origin.y;

        const distanceM =
            worldDistanceToMeters(Math.hypot(dx, dy));

        let azimuth =
            Math.atan2(dx, dy) * 180 / Math.PI;

        if (azimuth < 0) {
            azimuth += 360;
        }

        let mil = {
            single: null,
            low: null,
            high: null,
            text: '—',
            detail: '',
            inRange: false
        };

        let rangeText = '';

        if (weapon) {
            const flat =
                getWeaponElevationSolutions(weapon, distanceM);

            const resolved =
                resolveElevationSolutions(weapon, distanceM, flat);

            const solutions = resolved.solutions || flat;

            /*
             * Same text the saved-target cards and the result panel show,
             * including the terrain-corrected variant when it is active.
             */
            const summary =
                getSavedTargetElevationSummary(
                    weapon,
                    distanceM,
                    S.origin,
                    S.target
                );

            mil = {
                single: solutions.single?.mil ?? null,
                low: solutions.low?.mil ?? null,
                high: solutions.high?.mil ?? null,
                text: summary.primary,
                detail: summary.secondary,
                inRange: summary.inRange
            };

            const minM = Math.round((weapon.minRange ?? 0) * 1000);
            const maxM = Math.round((weapon.maxRange ?? weapon.range) * 1000);

            rangeText =
                minM > 0
                    ? `${minM}–${maxM} m`
                    : `${maxM} m`;
        }

        const activeIds =
            typeof activeSavedTargetIds === 'function'
                ? activeSavedTargetIds()
                : new Set();

        const targets = savedTargets.map((target, index) => ({
            id: String(target.id),
            index,
            name: target.name,
            x: Number(target.x),
            y: Number(target.y),
            active: activeIds.has(String(target.id))
        }));

        const activeTarget =
            targets.find(target => target.active) || null;

        const weapons =
            Object.values(WEAPONS).map(item => ({
                id: item.id,
                name: getWeaponName(item)
            }));

        const copyText =
            `AZ ${azimuth.toFixed(1)}°  ` +
            `MIL ${mil.text}  ` +
            `DIST ${Math.round(distanceM)} m`;

        return {
            gen: ++generation,
            weapon: S.weapon,
            weaponName: weapon ? getWeaponName(weapon) : '',
            weapons,
            map: S.map,
            mapName:
                S.map === 'custom'
                    ? 'Custom'
                    : (MAPS[S.map]?.name || S.map),
            origin: pointSnapshot(S.origin),
            target: pointSnapshot(S.target),
            distanceM,
            distanceKm: distanceM / 1000,
            azimuth,
            dxM: worldDistanceToMeters(dx),
            dyM: worldDistanceToMeters(dy),
            mil,
            inRange: mil.inRange,
            rangeText,
            savedTargets: targets,
            activeTargetId: activeTarget ? activeTarget.id : null,
            activeTargetName: activeTarget ? activeTarget.name : '',
            activeTargetIndex: activeTarget ? activeTarget.index : -1,
            copyText
        };
    }

    function publish() {
        if (publishScheduled) {
            return;
        }

        publishScheduled = true;

        /*
         * inputs() runs on every frame of a map drag; one publish per
         * animation frame is plenty for a 1 s deck poll and the
         * command round-trip.
         */
        window.requestAnimationFrame(() => {
            publishScheduled = false;

            try {
                invoke('publish_state', {
                    payload: buildState()
                });
            } catch (error) {
                console.warn('[deck-bridge] publish failed', error);
            }
        });
    }

    /*
     * Every writer of origin/target/weapon lands in inputs() or result();
     * saved-target edits land in renderSavedTargets(). Wrapping the global
     * bindings covers all of them without touching upstream code.
     */
    function wrapGlobal(name) {
        const original = window[name];

        if (typeof original !== 'function') {
            console.warn(`[deck-bridge] ${name}() not found; state may go stale`);
            return;
        }

        window[name] = function (...args) {
            const value = original.apply(this, args);
            publish();
            return value;
        };
    }

    ['inputs', 'result', 'renderSavedTargets'].forEach(wrapGlobal);

    /* ---------- commands ---------- */

    function movePoint(type, updates) {
        const point = S[type];

        if (!point) {
            return;
        }

        const next = {
            x: Number.isFinite(updates.x) ? roundCoordinate(updates.x) : point.x,
            y: Number.isFinite(updates.y) ? roundCoordinate(updates.y) : point.y
        };

        if (next.x === point.x && next.y === point.y) {
            return;
        }

        pushMapToolHistory();

        point.x = next.x;
        point.y = next.y;

        clamp(point);

        inputs();
    }

    function selectWeapon(id) {
        if (!WEAPONS[id] || id === S.weapon) {
            return;
        }

        const select = $('weapon');

        if (!select) {
            return;
        }

        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function stepSavedTarget(direction) {
        if (!savedTargets.length) {
            return;
        }

        const activeIds = activeSavedTargetIds();

        const current = savedTargets.findIndex(
            target => activeIds.has(String(target.id))
        );

        const count = savedTargets.length;

        const next =
            current < 0
                ? (direction > 0 ? 0 : count - 1)
                : (current + direction + count) % count;

        restoreTarget(savedTargets[next]);
    }

    const handlers = {
        nudge({ point, axis, delta }) {
            const source = S[point];

            if (!source || (axis !== 'x' && axis !== 'y')) {
                return;
            }

            movePoint(point, {
                [axis]: source[axis] + Number(delta || 0)
            });
        },

        set({ point, x, y }) {
            movePoint(point, {
                x: Number(x),
                y: Number(y)
            });
        },

        swap() {
            $('swap')?.click();
        },

        reset() {
            $('clear')?.click();
        },

        weapon({ id }) {
            selectWeapon(String(id || ''));
        },

        'weapon-next'() {
            const ids = Object.keys(WEAPONS);

            if (!ids.length) {
                return;
            }

            const index = ids.indexOf(S.weapon);
            selectWeapon(ids[(index + 1) % ids.length]);
        },

        'save-target'() {
            saveCurrentTarget();
        },

        'target-next'() {
            stepSavedTarget(1);
        },

        'target-prev'() {
            stepSavedTarget(-1);
        },

        'target-restore'({ id }) {
            const target = savedTargets.find(
                item => String(item.id) === String(id)
            );

            if (target) {
                restoreTarget(target);
            }
        }
    };

    listen('deck-cmd', event => {
        const payload = event?.payload || {};
        const handler = handlers[payload.cmd];

        if (!handler) {
            console.warn('[deck-bridge] unknown command', payload);
            return;
        }

        try {
            handler(payload);
        } catch (error) {
            console.error('[deck-bridge] command failed', payload, error);
        }

        /* Always answer, even when the command changed nothing. */
        publish();
    });

    /* Cover the case where init() already ran before this script. */
    if (WEAPONS && Object.keys(WEAPONS).length) {
        publish();
    }
})();
