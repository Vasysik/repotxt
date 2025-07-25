const vscode = acquireVsCodeApi();
let fileTreeData = null;
let expandedNodes = new Set();
let selectedNodes = new Set();
let lastSelectedNode = null;
let allNodePaths = [];
let renderTimeout = null;
let fileStructureCache = new Map();
let nodeStateCache = new Map();
let partialCache = new Map();
let isInitialLoad = true;
let domMap = new Map();
let isFirstRender = true;
let currentConfig = {
    showTooltipLineCount: true,
    showTooltipCharCount: true
};

const $ = (id) => document.getElementById(id);

function setArrowIcon(arrowEl, expanded){
    arrowEl.innerHTML = expanded
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072 12.333 5.715l.619.619L8.285 11H7.667L3 6.334l.619-.619 4.357 4.357Z" fill="currentColor"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.07 8.024 5.715 3.667l.619-.619L11 7.714v.619L6.334 13l-.619-.619 4.356-4.357Z" fill="currentColor"/></svg>' 
    arrowEl.classList.toggle('expanded', expanded)
}

function initializeEventListeners() {
    $('refreshBtn').addEventListener('click', () => {
        showTooltip('refreshBtn', 'Refreshing...');
        clearAllCaches();
        vscode.postMessage({ type: 'refresh' });
    });

    $('generateBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'generateReport' });
    });

    $('resetBtn').addEventListener('click', () => {
        showTooltip('resetBtn', 'Resetting...');
        clearAllCaches();
        vscode.postMessage({ type: 'resetExclusions' });
    });

    $('collapseBtn').addEventListener('click', () => {
        expandedNodes.clear();
        updateExpandedStates();
        showTooltip('collapseBtn', 'Collapsed all');
    });

    $('settingsBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'openSettings' });
    });

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'a') {
            e.preventDefault();
            selectAll();
        }
    });
}

function clearAllCaches() {
    fileStructureCache.clear();
    nodeStateCache.clear();
    partialCache.clear();
    domMap.clear();
    isFirstRender = true;
}

function selectAll() {
    selectedNodes = new Set(allNodePaths);
    updateSelectionStates();
}

function showTooltip(btnId, text) {
    const btn = $(btnId);
    const tooltip = btn.querySelector('.tooltip');
    const originalText = tooltip.textContent;
    tooltip.textContent = text;
    setTimeout(() => {
        tooltip.textContent = originalText;
    }, 1500);
}

window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'fileTree') {
        const isFirstLoad = fileTreeData === null;
        fileTreeData = message.data;
        if (message.config) {
            currentConfig = message.config;
        }
        if (isFirstLoad) {
            clearAllCaches();
        }
        debouncedRender();
    } else if (message.type === 'children') {
        const structureOnly = message.data.map(node => ({
            name: node.name,
            fullPath: node.fullPath,
            isDirectory: node.isDirectory,
            children: node.isDirectory ? null : []
        }));
        fileStructureCache.set(message.path, structureOnly);
        
        function updateNodeChildren(nodes, targetPath, newChildren) {
            for (const node of nodes) {
                if (node.fullPath === targetPath) {
                    node.children = newChildren;
                    return true;
                }
                if (node.children && node.children.length > 0) {
                    if (updateNodeChildren(node.children, targetPath, newChildren)) {
                        return true;
                    }
                }
            }
            return false;
        }
        
        updateNodeChildren(fileTreeData, message.path, message.data);
        renderChildren(message.path, message.data);
    } else if (message.type === 'nodeStates') {
        updateNodeStates(message.states);
    } else if (message.type === 'fullRefresh') {
        fileTreeData = null;
        clearAllCaches();
        isInitialLoad = true;
        vscode.postMessage({ type: 'getFileTree' });
    }
});

function updateNodeStates(states) {
    const stateMap = new Map(states.map(s => [s.path, { excluded: s.excluded, partial: s.partial }]));
    
    stateMap.forEach((state, path) => {
        nodeStateCache.set(path, state.excluded);
        partialCache.set(path, state.partial);
        const nodeEl = domMap.get(path);
        if (nodeEl) {
            updateNodeVisualState(nodeEl, state.excluded, state.partial);
        }
    });
    
    function updateStates(nodes) {
        nodes.forEach(node => {
            const state = stateMap.get(node.fullPath);
            if (state) {
                node.excluded = state.excluded;
                node.partial = state.partial;
            }
            
            if (node.children && node.children.length > 0) {
                updateStates(node.children);
            }
        });
    }
    
    if (fileTreeData) {
        updateStates(fileTreeData);
    }
}

function updateNodeVisualState(nodeContent, isExcluded, isPartial) {
    const treeNode = nodeContent.parentElement;
    if (isExcluded) {
        treeNode.classList.add('node-excluded');
    } else {
        treeNode.classList.remove('node-excluded');
    }
    
    const eyeBtn = nodeContent.querySelector('.eye-btn');
    if (eyeBtn) {
        eyeBtn.innerHTML = isExcluded 
            ? '<svg viewBox="0 0 16 16"><path d="M8 2C4.5 2 1.5 5 0 8c1.5 3 4.5 6 8 6s6.5-3 8-6c-1.5-3-4.5-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1 1l14 14" stroke="currentColor" stroke-width="1.3"/></svg>'
            : '<svg viewBox="0 0 16 16"><path d="M8 2C4.5 2 1.5 5 0 8c1.5 3 4.5 6 8 6s6.5-3 8-6c-1.5-3-4.5-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
    }
    
    const actions = nodeContent.querySelector('.node-actions');
    actions.style.position = 'relative';

    let clearBtn = actions.querySelector('.clear-btn');
    if (clearBtn) clearBtn.remove();
    
    let badge = nodeContent.querySelector('.partial-badge');
    if (badge) badge.remove();
    
    if (isPartial) {
        clearBtn = document.createElement('button');
        clearBtn.className = 'clear-btn';
        clearBtn.title = 'Clear selections';
        clearBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"> <path d="M10.0001 12.6L10.7001 13.3L12.3001 11.7L13.9001 13.3L14.7001 12.6L13.0001 11L14.7001 9.40005L13.9001 8.60005L12.3001 10.3L10.7001 8.60005L10.0001 9.40005L11.6001 11L10.0001 12.6Z" fill="currentColor"/> <path d="M1.00006 4L15.0001 4L15.0001 3L1.00006 3L1.00006 4Z" fill="currentColor"/> <path d="M1.00006 7L15.0001 7L15.0001 6L1.00006 6L1.00006 7Z" fill="currentColor"/> <path d="M9.00006 9.5L9.00006 9L1.00006 9L1.00006 10L9.00006 10L9.00006 9.5Z" fill="currentColor"/> <path d="M9.00006 13L9.00006 12.5L9.00006 12L1.00006 12L1.00006 13L9.00006 13Z" fill="currentColor"/> </svg>';
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const p = nodeContent.parentElement.dataset.path;
            vscode.postMessage({ type: 'clearSelections', path: p });
        });
        actions.appendChild(clearBtn);
        
        badge = document.createElement('span');
        badge.className = 'partial-badge';
        badge.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 10V9H14V10H2Z M2 6H14V7H2V6Z M14 3V4H2V3H14Z" fill="currentColor"/><path d="M2 12V13H14V12H2Z" fill="currentColor"/></svg>';
        nodeContent.appendChild(badge);
    }
}

function updateNodeExcludedState(nodeContent, isExcluded) {
    const partial = partialCache.get(nodeContent.parentElement.dataset.path) || false;
    updateNodeVisualState(nodeContent, isExcluded, partial);
}

function updateSelectionStates() {
    domMap.forEach((nodeContent, path) => {
        if (selectedNodes.has(path)) {
            nodeContent.classList.add(selectedNodes.size === 1 ? 'selected' : 'multi-selected');
            nodeContent.classList.remove(selectedNodes.size === 1 ? 'multi-selected' : 'selected');
        } else {
            nodeContent.classList.remove('selected', 'multi-selected');
        }
    });
}

function updateExpandedStates() {
    domMap.forEach((nodeContent, path) => {
        const nodeElement = nodeContent.parentElement;
        const childrenContainer = nodeElement.querySelector('.node-children');
        const arrow = nodeContent.querySelector('.arrow-icon');
        
        if (childrenContainer && arrow) {
            const exp = expandedNodes.has(path);
            if (exp) {
                childrenContainer.classList.add('expanded');
            } else {
                childrenContainer.classList.remove('expanded');
            }
            
            setArrowIcon(arrow, exp);
            
            updateFolderIcon(nodeContent, exp);
        }
    });
}

function updateFolderIcon(nodeContent, isExpanded) {
    const icon = nodeContent.querySelector('.folder-icon');
    if (icon) {
        icon.innerHTML = isExpanded 
            ? '<svg viewBox="0 0 16 16"><path d="M1.5 3v10a.5.5 0 00.5.5h12a.5.5 0 00.5-.5V6.5a.5.5 0 00-.5-.5h-6l-1.5-1.5h-5a.5.5 0 00-.5.5z" fill="currentColor"/></svg>'
            : '<svg viewBox="0 0 16 16"><path d="M1.5 3v10a.5.5 0 00.5.5h12a.5.5 0 00.5-.5V5.5a.5.5 0 00-.5-.5h-6l-1-1.5h-5a.5.5 0 00-.5.5z" fill="currentColor"/></svg>';
    }
}

function debouncedRender() {
    if (renderTimeout) {
        clearTimeout(renderTimeout);
    }
    renderTimeout = setTimeout(() => {
        renderFileTree();
    }, 50);
}

function collectAllPaths(nodes, paths = []) {
    nodes.forEach(node => {
        paths.push(node.fullPath);
        if (node.children && node.children.length > 0) {
            collectAllPaths(node.children, paths);
        }
    });
    return paths;
}

function renderFileTree() {
    const container = $('fileTree');

    if (!fileTreeData || fileTreeData.length === 0) {
        if (isInitialLoad) {
            container.innerHTML = `<div class="loading-container">
                <div class="spinner"></div>
                <div class="loading-text">Loading repository...</div>
            </div>`;
        } else {
            container.innerHTML = `<div class="empty-state">
                <svg class="empty-icon" viewBox="0 0 24 24" fill="none">
                    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" stroke="currentColor" stroke-width="1.5"/>
                </svg>
                <div>No workspace folder open</div>
            </div>`;
        }
        return;
    }

    isInitialLoad = false;
    allNodePaths = collectAllPaths(fileTreeData);
    
    if (isFirstRender) {
        container.innerHTML = '';
        const fragment = document.createDocumentFragment();
        fileTreeData.forEach(node => {
            fragment.appendChild(createTreeNode(node, 0, ''));
        });
        container.appendChild(fragment);
        isFirstRender = false;
    } else {
        updateSelectionStates();
        updateExpandedStates();
    }
}

function renderChildren(parentPath, children) {
    const parentContent = domMap.get(parentPath);
    if (!parentContent) return;
    
    const parentLevel = parseInt(parentContent.dataset.level, 10) || 0;
    
    const parentElement = parentContent.parentElement;
    let childrenContainer = parentElement.querySelector('.node-children');
    
    if (!childrenContainer) {
        childrenContainer = document.createElement('div');
        childrenContainer.className = 'node-children expanded';
        parentElement.appendChild(childrenContainer);
    }
    
    childrenContainer.innerHTML = '';
    
    const fragment = document.createDocumentFragment();
    children.forEach(child => {
        fragment.appendChild(createTreeNode(child, parentLevel + 1, parentPath));
    });
    childrenContainer.appendChild(fragment);
    
    expandedNodes.add(parentPath);
}

function getNodesBetween(startPath, endPath) {
    const startIndex = allNodePaths.indexOf(startPath);
    const endIndex = allNodePaths.indexOf(endPath);
    
    if (startIndex === -1 || endIndex === -1) return [];
    
    const from = Math.min(startIndex, endIndex);
    const to = Math.max(startIndex, endIndex);
    
    return allNodePaths.slice(from, to + 1);
}

async function loadChildren(node, nodeId) {
    if (node.children === null && !fileStructureCache.has(node.fullPath)) {
        vscode.postMessage({ type: 'getChildren', path: node.fullPath });
    } else if (node.children === null && fileStructureCache.has(node.fullPath)) {
        const cached = fileStructureCache.get(node.fullPath);
        node.children = cached;
        vscode.postMessage({ type: 'getNodeStates', paths: cached.map(c => c.fullPath) });
    }
}

function getAllDescendantPaths(node) {
    const paths = [];
    
    function collect(n) {
        paths.push(n.fullPath);
        if (n.children && n.children.length > 0) {
            n.children.forEach(child => collect(child));
        }
    }
    
    collect(node);
    return paths;
}

function createTreeNode(node, level, parentPath) {
    const nodeElement = document.createElement('div');
    
    const isExcluded = nodeStateCache.has(node.fullPath) ? nodeStateCache.get(node.fullPath) : node.excluded;
    node.excluded = isExcluded;
    
    const isPartial = partialCache.has(node.fullPath) ? partialCache.get(node.fullPath) : node.partial;
    node.partial = isPartial;
    
    nodeElement.className = 'tree-node' + (isExcluded ? ' node-excluded' : '');
    nodeElement.dataset.path = node.fullPath;

    const content = document.createElement('div');
    content.className = 'node-content';
    content.dataset.level = level;
    
    if (selectedNodes.has(node.fullPath)) {
        content.classList.add(selectedNodes.size === 1 ? 'selected' : 'multi-selected');
    }
    
    content.style.paddingLeft = `${level * 20 + 8}px`;

    const hasChildren = node.isDirectory && (node.children === null || (node.children && node.children.length > 0));
    
    if (hasChildren) {
        const arrow = document.createElement('div');
        arrow.className = 'node-arrow arrow-icon';
        
        setArrowIcon(arrow, expandedNodes.has(node.fullPath));

        arrow.addEventListener('click', async (e) => {
            e.stopPropagation();
            await toggleNode(node.fullPath, node);
        });

        content.appendChild(arrow);
    } else {
        const spacer = document.createElement('div');
        spacer.className = 'node-arrow';
        content.appendChild(spacer);
    }

    const icon = document.createElement('div');
    icon.className = 'node-icon ' + (node.isDirectory ? 'folder-icon' : 'file-icon');
    
    if (node.isDirectory) {
        const isExpanded = expandedNodes.has(node.fullPath);
        icon.innerHTML = isExpanded 
            ? '<svg viewBox="0 0 16 16"><path d="M1.5 3v10a.5.5 0 00.5.5h12a.5.5 0 00.5-.5V6.5a.5.5 0 00-.5-.5h-6l-1.5-1.5h-5a.5.5 0 00-.5.5z" fill="currentColor"/></svg>'
            : '<svg viewBox="0 0 16 16"><path d="M1.5 3v10a.5.5 0 00.5.5h12a.5.5 0 00.5-.5V5.5a.5.5 0 00-.5-.5h-6l-1-1.5h-5a.5.5 0 00-.5.5z" fill="currentColor"/></svg>';
    } else {
        icon.innerHTML = '<svg viewBox="0 0 16 16"><path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" fill="currentColor"/><path d="M9 1v4h4" fill="white" opacity="0.4"/></svg>';
    }

    const name = document.createElement('span');
    name.className = 'node-name';
    name.textContent = node.name;

    const actions = document.createElement('div');
    actions.className = 'node-actions';
    actions.style.position = 'relative';

    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'eye-btn';
    eyeBtn.innerHTML = isExcluded 
        ? '<svg viewBox="0 0 16 16"><path d="M8 2C4.5 2 1.5 5 0 8c1.5 3 4.5 6 8 6s6.5-3 8-6c-1.5-3-4.5-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1 1l14 14" stroke="currentColor" stroke-width="1.3"/></svg>'
        : '<svg viewBox="0 0 16 16"><path d="M8 2C4.5 2 1.5 5 0 8c1.5 3 4.5 6 8 6s6.5-3 8-6c-1.5-3-4.5-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

    eyeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pathsToToggle = selectedNodes.has(node.fullPath) 
            ? Array.from(selectedNodes) 
            : [node.fullPath];
        
        if (node.children) {
            pathsToToggle.forEach(path => {
                const targetNode = findNodeByPath(fileTreeData, path);
                if (targetNode) {
                    clearCacheForPath(path);
                }
            });
        }
        
        vscode.postMessage({ type: 'toggleExcludeMultiple', paths: pathsToToggle });
    });

    actions.appendChild(eyeBtn);

    if (node.partial) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'clear-btn';
        clearBtn.title = 'Clear selections';
        clearBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"> <path d="M10.0001 12.6L10.7001 13.3L12.3001 11.7L13.9001 13.3L14.7001 12.6L13.0001 11L14.7001 9.40005L13.9001 8.60005L12.3001 10.3L10.7001 8.60005L10.0001 9.40005L11.6001 11L10.0001 12.6Z" fill="currentColor"/> <path d="M1.00006 4L15.0001 4L15.0001 3L1.00006 3L1.00006 4Z" fill="currentColor"/> <path d="M1.00006 7L15.0001 7L15.0001 6L1.00006 6L1.00006 7Z" fill="currentColor"/> <path d="M9.00006 9.5L9.00006 9L1.00006 9L1.00006 10L9.00006 10L9.00006 9.5Z" fill="currentColor"/> <path d="M9.00006 13L9.00006 12.5L9.00006 12L1.00006 12L1.00006 13L9.00006 13Z" fill="currentColor"/> </svg>';
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'clearSelections', path: node.fullPath });
        });
        actions.appendChild(clearBtn);
    }

    content.appendChild(icon);
    content.appendChild(name);
    content.appendChild(actions);

    if (node.partial) {
        const badge = document.createElement('span');
        badge.className = 'partial-badge';
        badge.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 10V9H14V10H2Z M2 6H14V7H2V6Z M14 3V4H2V3H14Z" fill="currentColor"/><path d="M2 12V13H14V12H2Z" fill="currentColor"/></svg>';
        content.appendChild(badge);
    }

    if (node.isDirectory && node.folderFiles > 0) {
        const parts = [];
        if (currentConfig.showTooltipLineCount && node.folderLines !== undefined) {
            parts.push(`${node.folderLines.toLocaleString()} lines`);
        }
        if (currentConfig.showTooltipCharCount && node.folderChars !== undefined) {
            parts.push(`${node.folderChars.toLocaleString()} chars`);
        }
        if (parts.length > 0) {
            parts.push(`${node.folderFiles} files`);
            nodeElement.title = parts.join(' | ');
        }
    } else if (!node.isDirectory && (node.lines !== undefined || node.chars !== undefined)) {
        const parts = [];
        if (currentConfig.showTooltipLineCount && node.lines !== undefined) {
            parts.push(`${node.lines.toLocaleString()} lines`);
        }
        if (currentConfig.showTooltipCharCount && node.chars !== undefined) {
            parts.push(`${node.chars.toLocaleString()} chars`);
        }
        if (parts.length > 0) {
            nodeElement.title = parts.join(' | ');
        }
    }

    content.addEventListener('click', async (e) => {
        const ctrlPressed = e.ctrlKey || e.metaKey;
        const shiftPressed = e.shiftKey;
        
        if (!ctrlPressed && !shiftPressed) {
            selectedNodes.clear();
            selectedNodes.add(node.fullPath);
            lastSelectedNode = node.fullPath;
        } else if (ctrlPressed && !shiftPressed) {
            if (selectedNodes.has(node.fullPath)) {
                selectedNodes.delete(node.fullPath);
            } else {
                selectedNodes.add(node.fullPath);
            }
            lastSelectedNode = node.fullPath;
        } else if (shiftPressed && lastSelectedNode) {
            selectedNodes.clear();
            const nodesToSelect = getNodesBetween(lastSelectedNode, node.fullPath);
            nodesToSelect.forEach(path => selectedNodes.add(path));
        }
        
        updateSelectionStates();

        if (!node.isDirectory && !ctrlPressed && !shiftPressed) {
            vscode.postMessage({ type: 'openFile', path: node.fullPath });
        } else if (node.isDirectory && hasChildren && !ctrlPressed && !shiftPressed) {
            await toggleNode(node.fullPath, node);
        }
    });

    domMap.set(node.fullPath, content);
    nodeElement.appendChild(content);

    if (node.isDirectory && expandedNodes.has(node.fullPath)) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'node-children expanded';

        if (node.children === null) {
            const loadingEl = document.createElement('div');
            loadingEl.style.paddingLeft = `${(level + 1) * 20 + 8}px`;
            loadingEl.style.height = '22px';
            loadingEl.style.display = 'flex';
            loadingEl.style.alignItems = 'center';
            loadingEl.style.opacity = '0.6';
            loadingEl.innerHTML = '<span style="font-size: 11px;">Loading...</span>';
            childrenContainer.appendChild(loadingEl);
            loadChildren(node, node.fullPath);
        } else if (node.children && node.children.length > 0) {
            node.children.forEach(child => {
                childrenContainer.appendChild(createTreeNode(child, level + 1, node.fullPath));
            });
        }

        nodeElement.appendChild(childrenContainer);
    }

    return nodeElement;
}

function findNodeByPath(nodes, targetPath) {
    for (const node of nodes) {
        if (node.fullPath === targetPath) {
            return node;
        }
        if (node.children && node.children.length > 0) {
            const found = findNodeByPath(node.children, targetPath);
            if (found) return found;
        }
    }
    return null;
}

function clearCacheForPath(path) {
    fileStructureCache.forEach((value, key) => {
        if (key.startsWith(path)) {
            fileStructureCache.delete(key);
        }
    });
    nodeStateCache.forEach((value, key) => {
        if (key.startsWith(path)) {
            nodeStateCache.delete(key);
        }
    });
    partialCache.forEach((value, key) => {
        if (key.startsWith(path)) {
            partialCache.delete(key);
        }
    });
}

async function toggleNode(fullPath, node) {
    const nodeContent = domMap.get(fullPath);
    if (!nodeContent) return;
    
    const nodeElement = nodeContent.parentElement;
    
    if (expandedNodes.has(fullPath)) {
        expandedNodes.delete(fullPath);
    } else {
        expandedNodes.add(fullPath);
        
        let childrenContainer = nodeElement.querySelector('.node-children');
        if (!childrenContainer && node.isDirectory) {
            childrenContainer = document.createElement('div');
            childrenContainer.className = 'node-children expanded';
            nodeElement.appendChild(childrenContainer);
            
            if (node.children === null) {
                const level = parseInt(nodeContent.dataset.level, 10) || 0;
                const loadingEl = document.createElement('div');
                loadingEl.style.paddingLeft = `${(level + 1) * 20 + 8}px`;
                loadingEl.style.height = '22px';
                loadingEl.style.display = 'flex';
                loadingEl.style.alignItems = 'center';
                loadingEl.style.opacity = '0.6';
                loadingEl.innerHTML = '<span style="font-size: 11px;">Loading...</span>';
                childrenContainer.appendChild(loadingEl);
                await loadChildren(node, fullPath);
            }
        }
        
        if (childrenContainer) {
            childrenContainer.classList.add('expanded');
        }
    }
    
    const arrow = nodeContent.querySelector('.arrow-icon');
    if (arrow) {
        setArrowIcon(arrow, expandedNodes.has(fullPath));
    }
    
    updateExpandedStates();
}

initializeEventListeners();
vscode.postMessage({ type: 'getFileTree' });
