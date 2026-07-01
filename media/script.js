// Webview script for the file tree.
// Goals vs the previous version:
//  - Stop blowing away DOM/state on every backend refresh — only patch what changed
//  - Folder stats are populated on demand (tooltip on hover) instead of eagerly
//    pre-computed by the backend for the whole tree
//  - Add a search bar that asks the backend for matches and renders a flat list
//  - Use the icon module to render distinguishable file-type icons

(function () {
    const vscode = acquireVsCodeApi();

    const state = {
        tree: null,                            // root-level node list
        expanded: new Set(),                   // expanded folder paths
        selected: new Set(),                   // selected paths (multi-select)
        lastSelected: null,
        allOrderedPaths: [],                   // for shift-select range
        domMap: new Map(),                     // path → .node-content element
        nodeMap: new Map(),                    // path → current node metadata
        excludedCache: new Map(),              // path → bool (last known)
        partialCache: new Map(),               // path → bool
        statsCache: new Map(),                 // path → {type, lines, chars, files}
        config: { showTooltipLineCount: true, showTooltipCharCount: true },
        firstLoadInProgress: true,
        searchActive: false,
        searchMatches: [],
        searchQuery: '',
        clipboard: { mode: null, paths: new Set() },
    };

    const $ = (id) => document.getElementById(id);

    // ----------------------------------------------------------------- init --
    function init() {
        wireToolbar();
        wireSearch();
        wireGlobalKeys();
        wireBlankContextMenu();
        vscode.postMessage({ type: 'getFileTree' });
    }

    function wireToolbar() {
        $('refreshBtn').addEventListener('click', () => {
            tooltipFlash('refreshBtn', 'Refreshing...');
            // Don't trash the DOM here — backend will send a fresh tree and we patch.
            vscode.postMessage({ type: 'refresh' });
        });
        $('generateBtn').addEventListener('click', () => vscode.postMessage({ type: 'generateReport' }));
        $('resetBtn').addEventListener('click', () => {
            tooltipFlash('resetBtn', 'Resetting...');
            vscode.postMessage({ type: 'resetExclusions' });
        });
        $('toggleAllBtn').addEventListener('click', () => {
            tooltipFlash('toggleAllBtn', 'Toggling all...');
            vscode.postMessage({ type: 'toggleAll' });
        });
        $('collapseBtn').addEventListener('click', () => {
            state.expanded.clear();
            applyExpandedClasses();
            tooltipFlash('collapseBtn', 'Collapsed all');
        });
        $('settingsBtn').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    }

    function wireSearch() {
        const input = $('searchInput');
        const clearBtn = $('searchClearBtn');

        let timer = null;
        input.addEventListener('input', () => {
            if (timer) clearTimeout(timer);
            const q = input.value.trim();
            clearBtn.style.display = q ? 'flex' : 'none';
            if (!q) {
                state.searchActive = false;
                state.searchQuery = '';
                renderTree();
                return;
            }
            timer = setTimeout(() => {
                state.searchQuery = q;
                state.searchActive = true;
                vscode.postMessage({ type: 'searchFiles', query: q });
            }, 180);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                input.value = '';
                clearBtn.style.display = 'none';
                state.searchActive = false;
                state.searchQuery = '';
                renderTree();
            }
        });
        clearBtn.addEventListener('click', () => {
            input.value = '';
            clearBtn.style.display = 'none';
            state.searchActive = false;
            state.searchQuery = '';
            renderTree();
            input.focus();
        });
    }

    function wireGlobalKeys() {
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                $('searchInput').focus();
                $('searchInput').select();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'a' && document.activeElement !== $('searchInput')) {
                e.preventDefault();
                state.selected = new Set(state.allOrderedPaths);
                applySelectionClasses();
                return;
            }
            if (document.activeElement === $('searchInput')) return;

            const selectedPaths = Array.from(state.selected);
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && selectedPaths.length) {
                e.preventDefault();
                vscode.postMessage({ type: 'cut', paths: selectedPaths });
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selectedPaths.length) {
                e.preventDefault();
                vscode.postMessage({ type: 'copy', paths: selectedPaths });
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
                e.preventDefault();
                const target = selectedPaths.length === 1 ? selectedPaths[0] : null;
                vscode.postMessage({ type: 'paste', path: target });
                return;
            }
            if (e.key === 'Delete' && selectedPaths.length) {
                e.preventDefault();
                vscode.postMessage({ type: 'delete', paths: selectedPaths });
                return;
            }
            if (e.key === 'F2' && selectedPaths.length === 1) {
                e.preventDefault();
                vscode.postMessage({ type: 'rename', path: selectedPaths[0] });
            }
        });

        document.addEventListener('click', hideContextMenu);
        document.addEventListener('scroll', hideContextMenu, true);
    }

    function wireBlankContextMenu() {
        const container = $('fileTree');
        container.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.node-content')) return;
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, null);
        });
    }

    function tooltipFlash(btnId, text) {
        const btn = $(btnId);
        if (!btn) return;
        const tip = btn.querySelector('.tooltip');
        if (!tip) return;
        const orig = tip.textContent;
        tip.textContent = text;
        setTimeout(() => { tip.textContent = orig; }, 1500);
    }

    // ----------------------------------------------------------- messaging --
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'fileTree': {
                const prevTree = state.tree;
                state.tree = msg.data || [];
                if (msg.config) state.config = msg.config;
                state.firstLoadInProgress = false;
                // Merge children we'd already loaded so a refresh (which only
                // resends the top level) doesn't drop expanded subtrees. The
                // actual node source of truth is path-keyed nodeMap, so refreshed
                // children replace old entries instead of living forever in a
                // stale nested array.
                preserveLoadedChildren(state.tree, prevTree);
                rebuildNodeMap();
                if (!state.searchActive) {
                    reconcileTree();
                    // Backend only resends the top level on refresh, so deep
                    // expanded folders need their own child refresh. This is what
                    // lets newly-created files appear inside already-open folders.
                    requestChildrenForExpanded();
                    requestStatesForRendered();
                }
                break;
            }
            case 'children': {
                const node = findInTree(state.tree, msg.path);
                if (node) {
                    removeKnownChildrenFromMap(node);
                    node.children = msg.data || [];
                    indexNodes(node.children);
                    if (!state.searchActive) renderChildren(msg.path);
                }
                break;
            }
            case 'nodeStates': {
                for (const s of msg.states) {
                    state.excludedCache.set(s.path, s.excluded);
                    state.partialCache.set(s.path, s.partial);
                    const dom = state.domMap.get(s.path);
                    if (dom) applyVisualState(dom, s.excluded, s.partial);
                    const node = findInTree(state.tree, s.path);
                    if (node) {
                        node.excluded = s.excluded;
                        node.partial = s.partial;
                    }
                }
                break;
            }
            case 'clipboardState': {
                state.clipboard.mode = msg.mode || null;
                state.clipboard.paths = new Set(msg.paths || []);
                applyClipboardClasses();
                break;
            }
            case 'statsUpdate': {
                for (const { path, stats } of msg.list) {
                    state.statsCache.set(path, stats);
                    applyTooltip(path, stats);
                }
                break;
            }
            case 'searchResults': {
                if (msg.query !== state.searchQuery) break; // stale
                state.searchMatches = msg.results || [];
                renderSearchResults();
                break;
            }
            case 'fullRefresh': {
                // Backend asks us to re-pull. Don't trash the DOM until new data arrives.
                vscode.postMessage({ type: 'getFileTree' });
                break;
            }
            case 'clearPathCache': {
                if (msg.path) {
                    state.statsCache.delete(msg.path);
                }
                break;
            }
        }
    });

    function rebuildNodeMap() {
        state.nodeMap.clear();
        indexNodes(state.tree || []);
    }

    function indexNodes(nodes) {
        if (!nodes) return;
        for (const n of nodes) {
            state.nodeMap.set(n.fullPath, n);
            if (n.children && n.children.length) indexNodes(n.children);
        }
    }

    function removeKnownChildrenFromMap(node) {
        if (!node || !node.children) return;
        const walk = (children) => {
            for (const child of children) {
                if (child.children) walk(child.children);
                state.nodeMap.delete(child.fullPath);
                state.statsCache.delete(child.fullPath);
            }
        };
        walk(node.children);
    }

    function requestChildrenForExpanded() {
        state.expanded.forEach((path) => {
            if (state.nodeMap.has(path)) {
                vscode.postMessage({ type: 'getChildren', path });
            }
        });
    }

    function preserveLoadedChildren(newNodes, prevTree) {
        if (!newNodes || !prevTree) return;
        for (const n of newNodes) {
            if (!n.isDirectory) continue;
            const old = findInTree(prevTree, n.fullPath);
            // The backend resends only the top level, so a refreshed directory
            // node arrives with children === null. If we'd already loaded its
            // subtree, graft it back (state on those children is refreshed
            // separately via getNodeStates).
            if (old && old.children && old.children.length && (!n.children || n.children.length === 0)) {
                n.children = old.children;
            }
        }
    }

    function findInTree(nodes, target) {
        if (!target) return null;
        const mapped = state.nodeMap.get(target);
        if (mapped) return mapped;
        if (!nodes) return null;
        for (const n of nodes) {
            if (n.fullPath === target) return n;
            if (n.children && n.children.length) {
                const f = findInTree(n.children, target);
                if (f) return f;
            }
        }
        return null;
    }

    // --------------------------------------------------------------- render --
    function renderTree() {
        const container = $('fileTree');
        state.searchActive = false;

        if (!state.tree || state.tree.length === 0) {
            if (state.firstLoadInProgress) {
                container.innerHTML = `<div class="loading-container"><div class="spinner"></div><div class="loading-text">Loading repository...</div></div>`;
            } else {
                container.innerHTML = `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" stroke="currentColor" stroke-width="1.5"/></svg><div>No workspace folder open</div></div>`;
            }
            return;
        }

        container.innerHTML = '';
        state.domMap.clear();
        state.allOrderedPaths = [];
        const frag = document.createDocumentFragment();
        for (const node of state.tree) {
            frag.appendChild(createTreeNode(node, 0));
        }
        container.appendChild(frag);
    }

    // Reconcile a fresh backend tree against the existing DOM. If the structure
    // is unchanged (the common case for exclude/reset/toggle-all — those only
    // change state, not which nodes exist), we patch visual state in place with
    // zero teardown. Only a real structural change triggers a full rebuild.
    function reconcileTree() {
        state.searchActive = false;
        if (!state.tree || state.tree.length === 0) {
            renderTree();
            return;
        }

        const expected = expectedOrderedPaths();
        let sameStructure = expected.length === state.domMap.size;
        if (sameStructure) {
            for (const p of expected) {
                if (!state.domMap.has(p)) { sameStructure = false; break; }
            }
        }

        if (!sameStructure) {
            renderTree();
            rebuildOrderedPaths();
            return;
        }

        // Structure identical → patch visual state only, no DOM churn.
        for (const p of expected) {
            const content = state.domMap.get(p);
            const node = content && findInTree(state.tree, p);
            if (content && node) applyVisualState(content, !!node.excluded, !!node.partial);
        }
        applySelectionClasses();
    }

    // Paths that SHOULD be in the DOM. Collapsing only hides children via CSS
    // (they stay in the DOM and domMap), so descend into any subtree whose
    // children were actually rendered — not just currently-expanded ones.
    function expectedOrderedPaths() {
        const out = [];
        const walk = (nodes) => {
            for (const n of nodes) {
                out.push(n.fullPath);
                if (n.isDirectory && n.children && n.children.length
                    && n.children.some(c => state.domMap.has(c.fullPath))) {
                    walk(n.children);
                }
            }
        };
        if (state.tree) walk(state.tree);
        return out;
    }

    // Ask the backend for the up-to-date excluded/partial state of every node
    // currently rendered. The backend handler is pure in-memory lookups, so this
    // is cheap even with a few hundred visible rows.
    function requestStatesForRendered() {
        const paths = [];
        state.domMap.forEach((_, p) => paths.push(p));
        if (paths.length) vscode.postMessage({ type: 'getNodeStates', paths });
    }

    function renderChildren(parentPath) {
        const parentContent = state.domMap.get(parentPath);
        if (!parentContent) return;
        const parentLevel = parseInt(parentContent.dataset.level, 10) || 0;
        const parentEl = parentContent.parentElement;
        let kidsEl = parentEl.querySelector(':scope > .node-children');
        if (!kidsEl) {
            kidsEl = document.createElement('div');
            kidsEl.className = 'node-children expanded';
            parentEl.appendChild(kidsEl);
        }
        kidsEl.innerHTML = '';
        const parent = findInTree(state.tree, parentPath);
        const kids = parent && parent.children ? parent.children : [];
        const frag = document.createDocumentFragment();
        for (const child of kids) {
            frag.appendChild(createTreeNode(child, parentLevel + 1));
        }
        kidsEl.appendChild(frag);
        kidsEl.classList.add('expanded');
        rebuildOrderedPaths();
    }

    function rebuildOrderedPaths() {
        state.allOrderedPaths = [];
        const walk = (nodes) => {
            for (const n of nodes) {
                state.allOrderedPaths.push(n.fullPath);
                if (n.isDirectory && state.expanded.has(n.fullPath) && n.children && n.children.length) {
                    walk(n.children);
                }
            }
        };
        if (state.tree) walk(state.tree);
    }

    function createTreeNode(node, level) {
        // The tree carries backend truth; the caches only mirror it (and any
        // nodeStates patches that arrive between renders also update node.*),
        // so read straight from the node and keep the caches in sync.
        const isExcluded = !!node.excluded;
        const isPartial = !!node.partial;
        const isCut = isCutPath(node.fullPath);
        state.excludedCache.set(node.fullPath, isExcluded);
        state.partialCache.set(node.fullPath, isPartial);

        const root = document.createElement('div');
        root.className = 'tree-node' + (isExcluded ? ' node-excluded' : '') + (isCut ? ' node-cut' : '');
        root.dataset.path = node.fullPath;

        const content = document.createElement('div');
        content.className = 'node-content';
        content.dataset.level = String(level);
        if (state.selected.has(node.fullPath)) {
            content.classList.add(state.selected.size === 1 ? 'selected' : 'multi-selected');
        }
        content.style.paddingLeft = `${level * 16 + 6}px`;

        // arrow / spacer
        const hasChildren = node.isDirectory && (node.children === null || (node.children && node.children.length > 0));
        if (hasChildren) {
            const arrow = document.createElement('div');
            arrow.className = 'node-arrow arrow-icon';
            setArrowIcon(arrow, state.expanded.has(node.fullPath));
            arrow.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleNode(node);
            });
            content.appendChild(arrow);
        } else {
            const spacer = document.createElement('div');
            spacer.className = 'node-arrow';
            content.appendChild(spacer);
        }

        // icon
        const iconEl = document.createElement('div');
        iconEl.className = 'node-icon ' + (node.isDirectory ? 'folder-icon' : 'file-icon');
        iconEl.innerHTML = window.RepoIcons.getNodeIconSvg(node.name, node.isDirectory, state.expanded.has(node.fullPath));
        content.appendChild(iconEl);

        // name
        const name = document.createElement('span');
        name.className = 'node-name';
        name.textContent = node.name;
        content.appendChild(name);

        if (isCut) {
            content.appendChild(createCutBadge());
        }

        // partial badge (positioned via CSS — sits under hover actions)
        if (isPartial) {
            const badge = document.createElement('span');
            badge.className = 'partial-badge';
            badge.innerHTML = '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>';
            badge.title = 'Has partial selection';
            content.appendChild(badge);
        }

        // actions (eye / clear) on the right
        const actions = document.createElement('div');
        actions.className = 'node-actions';
        const eye = document.createElement('button');
        eye.className = 'eye-btn';
        eye.title = isExcluded ? 'Include' : 'Exclude';
        eye.innerHTML = eyeSvg(isExcluded);
        eye.addEventListener('click', (e) => {
            e.stopPropagation();
            const paths = state.selected.has(node.fullPath) ? Array.from(state.selected) : [node.fullPath];
            vscode.postMessage({ type: 'toggleExcludeMultiple', paths });
        });
        actions.appendChild(eye);

        if (isPartial) {
            const clear = document.createElement('button');
            clear.className = 'clear-btn';
            clear.title = 'Clear selections';
            clear.innerHTML = clearSvg();
            clear.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ type: 'clearSelections', path: node.fullPath });
            });
            actions.appendChild(clear);
        }
        content.appendChild(actions);

        // tooltip
        applyTooltipElement(content, node);

        // click
        content.addEventListener('click', (e) => {
            const ctrl = e.ctrlKey || e.metaKey;
            const shift = e.shiftKey;
            if (!ctrl && !shift) {
                state.selected.clear();
                state.selected.add(node.fullPath);
                state.lastSelected = node.fullPath;
            } else if (ctrl && !shift) {
                if (state.selected.has(node.fullPath)) state.selected.delete(node.fullPath);
                else state.selected.add(node.fullPath);
                state.lastSelected = node.fullPath;
            } else if (shift && state.lastSelected) {
                rebuildOrderedPaths();
                const a = state.allOrderedPaths.indexOf(state.lastSelected);
                const b = state.allOrderedPaths.indexOf(node.fullPath);
                if (a !== -1 && b !== -1) {
                    const [from, to] = a < b ? [a, b] : [b, a];
                    state.selected.clear();
                    for (let i = from; i <= to; i++) state.selected.add(state.allOrderedPaths[i]);
                }
            }
            applySelectionClasses();

            if (!node.isDirectory && !ctrl && !shift) {
                vscode.postMessage({ type: 'openFile', path: node.fullPath });
            } else if (node.isDirectory && hasChildren && !ctrl && !shift) {
                toggleNode(node);
            }
        });

        content.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectForContextMenu(node.fullPath);
            showContextMenu(e.clientX, e.clientY, node);
        });

        // Lazy folder stats: when a folder element is rendered, defer a request
        // for its stats so the tooltip can show line/char counts. Don't ask if
        // we already have it.
        if (node.isDirectory && !state.statsCache.has(node.fullPath)) {
            requestIdleStats(node.fullPath);
        }

        state.domMap.set(node.fullPath, content);
        root.appendChild(content);

        // children
        if (node.isDirectory && state.expanded.has(node.fullPath)) {
            const kids = document.createElement('div');
            kids.className = 'node-children expanded';
            if (node.children === null) {
                kids.appendChild(loadingPlaceholder(level + 1));
                vscode.postMessage({ type: 'getChildren', path: node.fullPath });
            } else if (node.children && node.children.length) {
                for (const child of node.children) {
                    kids.appendChild(createTreeNode(child, level + 1));
                }
            }
            root.appendChild(kids);
        }

        state.allOrderedPaths.push(node.fullPath);
        return root;
    }

    function loadingPlaceholder(level) {
        const el = document.createElement('div');
        el.className = 'node-loading';
        el.style.paddingLeft = `${level * 16 + 28}px`;
        el.innerHTML = '<span>Loading...</span>';
        return el;
    }

    // Idle queue for folder-stats requests so we don't fire dozens at once.
    const idleStatsQueue = [];
    let idleStatsRunning = false;
    function requestIdleStats(p) {
        idleStatsQueue.push(p);
        if (idleStatsRunning) return;
        idleStatsRunning = true;
        const run = () => {
            const batch = idleStatsQueue.splice(0, 12);
            for (const path of batch) {
                vscode.postMessage({ type: 'getFolderStats', path });
            }
            if (idleStatsQueue.length) {
                (window.requestIdleCallback || setTimeout)(run, 30);
            } else {
                idleStatsRunning = false;
            }
        };
        (window.requestIdleCallback || setTimeout)(run, 30);
    }

    function isCutPath(path) {
        return state.clipboard.mode === 'cut' && state.clipboard.paths.has(path);
    }

    function createCutBadge() {
        const badge = document.createElement('span');
        badge.className = 'cut-badge';
        badge.textContent = 'Cut';
        badge.title = 'Cut: will be moved on paste';
        return badge;
    }

    function applyClipboardClasses() {
        state.domMap.forEach((content, path) => {
            const treeNode = content.parentElement;
            const isCut = isCutPath(path);
            treeNode.classList.toggle('node-cut', isCut);
            let badge = content.querySelector(':scope > .cut-badge');
            if (isCut && !badge) {
                const name = content.querySelector('.node-name, .search-name-wrap');
                const cutBadge = createCutBadge();
                if (name && name.nextSibling) content.insertBefore(cutBadge, name.nextSibling);
                else if (name) content.insertBefore(cutBadge, name.nextSibling);
                else content.appendChild(cutBadge);
            } else if (!isCut && badge) {
                badge.remove();
            }
        });
    }

    // --------------------------------------------------- visual updates ----
    function applyVisualState(content, isExcluded, isPartial) {
        const treeNode = content.parentElement;
        treeNode.classList.toggle('node-excluded', !!isExcluded);

        const eye = content.querySelector('.eye-btn');
        if (eye) {
            eye.innerHTML = eyeSvg(isExcluded);
            eye.title = isExcluded ? 'Include' : 'Exclude';
        }

        // partial badge
        let badge = content.querySelector('.partial-badge');
        if (isPartial && !badge) {
            badge = document.createElement('span');
            badge.className = 'partial-badge';
            badge.innerHTML = '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>';
            badge.title = 'Has partial selection';
            // insert before the actions
            const actions = content.querySelector('.node-actions');
            if (actions) content.insertBefore(badge, actions);
            else content.appendChild(badge);
        } else if (!isPartial && badge) {
            badge.remove();
        }

        // clear-selections button
        const actions = content.querySelector('.node-actions');
        if (actions) {
            let clearBtn = actions.querySelector('.clear-btn');
            if (isPartial && !clearBtn) {
                clearBtn = document.createElement('button');
                clearBtn.className = 'clear-btn';
                clearBtn.title = 'Clear selections';
                clearBtn.innerHTML = clearSvg();
                const path = treeNode.dataset.path;
                clearBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    vscode.postMessage({ type: 'clearSelections', path });
                });
                actions.appendChild(clearBtn);
            } else if (!isPartial && clearBtn) {
                clearBtn.remove();
            }
        }
    }

    function applySelectionClasses() {
        state.domMap.forEach((content, path) => {
            content.classList.remove('selected', 'multi-selected');
            if (state.selected.has(path)) {
                content.classList.add(state.selected.size === 1 ? 'selected' : 'multi-selected');
            }
        });
    }

    function applyExpandedClasses() {
        state.domMap.forEach((content, path) => {
            const treeNode = content.parentElement;
            const kids = treeNode.querySelector(':scope > .node-children');
            const arrow = content.querySelector('.arrow-icon');
            const expanded = state.expanded.has(path);
            if (kids) kids.classList.toggle('expanded', expanded);
            if (arrow) setArrowIcon(arrow, expanded);
            const iconEl = content.querySelector('.folder-icon');
            if (iconEl) {
                const name = content.querySelector('.node-name')?.textContent || '';
                iconEl.innerHTML = window.RepoIcons.getNodeIconSvg(name, true, expanded);
            }
        });
    }

    function applyTooltip(path, stats) {
        const content = state.domMap.get(path);
        if (!content || !stats) return;
        const parts = [];
        if (state.config.showTooltipLineCount && stats.lines !== undefined) {
            parts.push(`${stats.lines.toLocaleString()} lines`);
        }
        if (state.config.showTooltipCharCount && stats.chars !== undefined) {
            parts.push(`${stats.chars.toLocaleString()} chars`);
        }
        if (stats.type === 'dir' && stats.files !== undefined) {
            parts.push(`${stats.files} files`);
        }
        if (parts.length) content.title = parts.join(' | ');
    }

    function applyTooltipElement(content, node) {
        const cached = state.statsCache.get(node.fullPath);
        if (cached) {
            applyTooltip(node.fullPath, cached);
            return;
        }
        if (!node.isDirectory) {
            const parts = [];
            if (state.config.showTooltipLineCount && node.lines !== undefined) {
                parts.push(`${node.lines.toLocaleString()} lines`);
            }
            if (state.config.showTooltipCharCount && node.chars !== undefined) {
                parts.push(`${node.chars.toLocaleString()} chars`);
            }
            if (parts.length) content.title = parts.join(' | ');
        }
    }

    // ------------------------------------------------------- context menu ----
    let contextMenuEl = null;

    function selectForContextMenu(path) {
        if (!state.selected.has(path)) {
            state.selected.clear();
            state.selected.add(path);
            state.lastSelected = path;
            applySelectionClasses();
        }
    }

    function selectedPathsFor(path) {
        if (path && state.selected.has(path)) return Array.from(state.selected);
        return path ? [path] : [];
    }

    function showContextMenu(x, y, node) {
        hideContextMenu();
        const path = node ? node.fullPath : null;
        const paths = selectedPathsFor(path);

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.setAttribute('role', 'menu');

        const addItem = (label, action, options = {}) => {
            if (options.separator) {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                menu.appendChild(sep);
                return;
            }
            const item = document.createElement('button');
            item.className = 'context-menu-item';
            item.textContent = label;
            item.disabled = !!options.disabled;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                hideContextMenu();
                action();
            });
            menu.appendChild(item);
        };

        addItem('New File', () => vscode.postMessage({ type: 'createFile', path }));
        addItem('New Folder', () => vscode.postMessage({ type: 'createFolder', path }));
        addItem('', null, { separator: true });
        addItem('Generate Text Report', () => vscode.postMessage({ type: 'generateTextReport' }));
        addItem('Generate ZIP Report', () => vscode.postMessage({ type: 'generateZipReport' }));
        addItem('Copy Report as Text', () => vscode.postMessage({ type: 'copyTextReport' }));
        addItem('', null, { separator: true });
        addItem('Reveal in File Explorer', () => vscode.postMessage({ type: 'revealInExplorer', path }), { disabled: !path });
        addItem('Cut', () => vscode.postMessage({ type: 'cut', paths }), { disabled: paths.length === 0 });
        addItem('Copy', () => vscode.postMessage({ type: 'copy', paths }), { disabled: paths.length === 0 });
        addItem('Paste', () => vscode.postMessage({ type: 'paste', path }));
        addItem('Copy Path', () => vscode.postMessage({ type: 'copyPath', paths }), { disabled: paths.length === 0 });
        addItem('', null, { separator: true });
        addItem('Rename', () => vscode.postMessage({ type: 'rename', path }), { disabled: !path || paths.length !== 1 });
        addItem('Delete', () => vscode.postMessage({ type: 'delete', paths }), { disabled: paths.length === 0 });

        document.body.appendChild(menu);
        contextMenuEl = menu;

        const rect = menu.getBoundingClientRect();
        const left = Math.min(x, window.innerWidth - rect.width - 4);
        const top = Math.min(y, window.innerHeight - rect.height - 4);
        menu.style.left = `${Math.max(4, left)}px`;
        menu.style.top = `${Math.max(4, top)}px`;
    }

    function hideContextMenu() {
        if (contextMenuEl) {
            contextMenuEl.remove();
            contextMenuEl = null;
        }
    }

    // ---------------------------------------------------------- toggling ----
    function toggleNode(node) {
        const content = state.domMap.get(node.fullPath);
        if (!content) return;
        const el = content.parentElement;

        if (state.expanded.has(node.fullPath)) {
            state.expanded.delete(node.fullPath);
        } else {
            state.expanded.add(node.fullPath);
            // ensure children container exists
            let kids = el.querySelector(':scope > .node-children');
            if (!kids) {
                kids = document.createElement('div');
                kids.className = 'node-children expanded';
                el.appendChild(kids);
                if (node.children === null) {
                    const level = parseInt(content.dataset.level, 10) || 0;
                    kids.appendChild(loadingPlaceholder(level + 1));
                    vscode.postMessage({ type: 'getChildren', path: node.fullPath });
                } else if (node.children && node.children.length) {
                    const level = parseInt(content.dataset.level, 10) || 0;
                    for (const child of node.children) {
                        kids.appendChild(createTreeNode(child, level + 1));
                    }
                }
            }
        }
        const arrow = content.querySelector('.arrow-icon');
        if (arrow) setArrowIcon(arrow, state.expanded.has(node.fullPath));

        // refresh folder icon (open vs closed)
        const iconEl = content.querySelector('.folder-icon');
        if (iconEl) {
            iconEl.innerHTML = window.RepoIcons.getNodeIconSvg(node.name, true, state.expanded.has(node.fullPath));
        }

        const kids = el.querySelector(':scope > .node-children');
        if (kids) kids.classList.toggle('expanded', state.expanded.has(node.fullPath));
        rebuildOrderedPaths();
    }

    // ------------------------------------------------------------ search ----
    function renderSearchResults() {
        const container = $('fileTree');
        container.innerHTML = '';
        state.domMap.clear();
        const list = document.createElement('div');
        list.className = 'search-results';
        if (state.searchMatches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.innerHTML = '<div>No matches</div>';
            container.appendChild(empty);
            return;
        }
        for (const m of state.searchMatches) {
            list.appendChild(createSearchResultNode(m));
        }
        container.appendChild(list);
    }

    function createSearchResultNode(m) {
        const root = document.createElement('div');
        const isCut = isCutPath(m.fullPath);
        root.className = 'tree-node search-result' + (m.excluded ? ' node-excluded' : '') + (isCut ? ' node-cut' : '');
        root.dataset.path = m.fullPath;

        const content = document.createElement('div');
        content.className = 'node-content';
        content.dataset.level = '0';

        const spacer = document.createElement('div');
        spacer.className = 'node-arrow';
        content.appendChild(spacer);

        const icon = document.createElement('div');
        icon.className = 'node-icon ' + (m.isDirectory ? 'folder-icon' : 'file-icon');
        icon.innerHTML = window.RepoIcons.getNodeIconSvg(getBasename(m.relPath), m.isDirectory, false);
        content.appendChild(icon);

        const nameWrap = document.createElement('div');
        nameWrap.className = 'search-name-wrap';
        const name = document.createElement('span');
        name.className = 'node-name';
        name.innerHTML = highlightMatch(getBasename(m.relPath), state.searchQuery);
        const sub = document.createElement('span');
        sub.className = 'search-relpath';
        sub.textContent = dirname(m.relPath) || '.';
        nameWrap.appendChild(name);
        nameWrap.appendChild(sub);
        content.appendChild(nameWrap);
        if (isCut) {
            content.appendChild(createCutBadge());
        }

        const actions = document.createElement('div');
        actions.className = 'node-actions';
        const eye = document.createElement('button');
        eye.className = 'eye-btn';
        eye.title = m.excluded ? 'Include' : 'Exclude';
        eye.innerHTML = eyeSvg(m.excluded);
        eye.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'toggleExcludeMultiple', paths: [m.fullPath] });
        });
        actions.appendChild(eye);
        content.appendChild(actions);

        content.addEventListener('click', (e) => {
            const ctrl = e.ctrlKey || e.metaKey;
            if (!m.isDirectory && !ctrl) {
                vscode.postMessage({ type: 'openFile', path: m.fullPath });
            }
        });

        content.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectForContextMenu(m.fullPath);
            showContextMenu(e.clientX, e.clientY, { ...m, name: getBasename(m.relPath) });
        });

        state.domMap.set(m.fullPath, content);
        root.appendChild(content);
        return root;
    }

    function highlightMatch(text, q) {
        if (!q) return escapeHtml(text);
        const i = text.toLowerCase().indexOf(q.toLowerCase());
        if (i < 0) return escapeHtml(text);
        return escapeHtml(text.slice(0, i))
             + '<mark>' + escapeHtml(text.slice(i, i + q.length)) + '</mark>'
             + escapeHtml(text.slice(i + q.length));
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function getBasename(p) {
        const ix = p.lastIndexOf('/');
        return ix < 0 ? p : p.slice(ix + 1);
    }
    function dirname(p) {
        const ix = p.lastIndexOf('/');
        return ix < 0 ? '' : p.slice(0, ix);
    }

    // ----------------------------------------------------------- icons -----
    function setArrowIcon(el, expanded) {
        el.innerHTML = expanded
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072 12.333 5.715l.619.619L8.285 11H7.667L3 6.334l.619-.619 4.357 4.357Z" fill="currentColor"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.07 8.024 5.715 3.667l.619-.619L11 7.714v.619L6.334 13l-.619-.619 4.356-4.357Z" fill="currentColor"/></svg>';
        el.classList.toggle('expanded', expanded);
    }

    function eyeSvg(isExcluded) {
        return isExcluded
            ? '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 2C4.5 2 1.5 5 0 8c1.5 3 4.5 6 8 6s6.5-3 8-6c-1.5-3-4.5-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1 1l14 14" stroke="currentColor" stroke-width="1.3"/></svg>'
            : '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 2C4.5 2 1.5 5 0 8c1.5 3 4.5 6 8 6s6.5-3 8-6c-1.5-3-4.5-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
    }

    function clearSvg() {
        return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10.0001 12.6L10.7001 13.3L12.3001 11.7L13.9001 13.3L14.7001 12.6L13.0001 11L14.7001 9.40005L13.9001 8.60005L12.3001 10.3L10.7001 8.60005L10.0001 9.40005L11.6001 11L10.0001 12.6Z" fill="currentColor"/><path d="M1.00006 4L15.0001 4L15.0001 3L1.00006 3L1.00006 4Z" fill="currentColor"/><path d="M1.00006 7L15.0001 7L15.0001 6L1.00006 6L1.00006 7Z" fill="currentColor"/><path d="M9.00006 9.5L9.00006 9L1.00006 9L1.00006 10L9.00006 10L9.00006 9.5Z" fill="currentColor"/><path d="M9.00006 13L9.00006 12.5L9.00006 12L1.00006 12L1.00006 13L9.00006 13Z" fill="currentColor"/></svg>';
    }

    init();
})();
