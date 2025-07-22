const vscode = acquireVsCodeApi();
let fileTreeData = null;
let expandedNodes = new Set();
let selectedNodes = new Set();
let lastSelectedNode = null;
let allNodePaths = [];
let renderTimeout = null;
let loadedChildren = new Map();

const $ = (id) => document.getElementById(id);

function initializeEventListeners() {
    $('refreshBtn').addEventListener('click', () => {
        showTooltip('refreshBtn', 'Refreshing...');
        loadedChildren.clear();
        vscode.postMessage({ type: 'refresh' });
    });

    $('generateBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'generateReport' });
    });

    $('resetBtn').addEventListener('click', () => {
        showTooltip('resetBtn', 'Resetting...');
        loadedChildren.clear();
        vscode.postMessage({ type: 'resetExclusions' });
    });

    $('collapseBtn').addEventListener('click', () => {
        expandedNodes.clear();
        renderFileTree();
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

function selectAll() {
    selectedNodes = new Set(allNodePaths);
    renderFileTree();
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

function mergeTreeData(newData, oldData) {
    const oldDataMap = new Map();
    
    function buildMap(nodes) {
        nodes.forEach(node => {
            oldDataMap.set(node.fullPath, node);
            if (node.children && node.children.length > 0) {
                buildMap(node.children);
            }
        });
    }
    
    if (oldData) {
        buildMap(oldData);
    }
    
    function mergeNodes(newNodes) {
        return newNodes.map(newNode => {
            const oldNode = oldDataMap.get(newNode.fullPath);
            if (oldNode && oldNode.children && oldNode.children.length > 0 && newNode.children === null) {
                newNode.children = mergeNodes(oldNode.children);
            }
            return newNode;
        });
    }
    
    return mergeNodes(newData);
}

window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'fileTree') {
        const mergedData = mergeTreeData(message.data, fileTreeData);
        fileTreeData = mergedData;
        debouncedRender();
    } else if (message.type === 'children') {
        const cachedData = loadedChildren.get(message.path) || {};
        cachedData.children = message.data;
        loadedChildren.set(message.path, cachedData);
        
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
        debouncedRender();
    }
});

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
        container.innerHTML = `<div class="empty-state">
            <svg class="empty-icon" viewBox="0 0 24 24" fill="none">
                <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" stroke="currentColor" stroke-width="1.5"/>
            </svg>
            <div>No workspace folder open</div>
        </div>`;
        return;
    }

    allNodePaths = collectAllPaths(fileTreeData);
    
    const fragment = document.createDocumentFragment();
    fileTreeData.forEach(node => {
        fragment.appendChild(createTreeNode(node, 0, ''));
    });
    
    container.innerHTML = '';
    container.appendChild(fragment);
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
    if (node.children === null && !loadedChildren.has(node.fullPath)) {
        loadedChildren.set(node.fullPath, { loading: true });
        vscode.postMessage({ type: 'getChildren', path: node.fullPath });
    }
}

function createTreeNode(node, level, parentPath) {
    const nodeId = parentPath ? `${parentPath}/${node.name}` : node.name;
    const nodeElement = document.createElement('div');
    nodeElement.className = 'tree-node' + (node.excluded ? ' node-excluded' : '');
    nodeElement.dataset.path = node.fullPath;

    const content = document.createElement('div');
    content.className = 'node-content';
    
    if (selectedNodes.has(node.fullPath)) {
        content.classList.add(selectedNodes.size === 1 ? 'selected' : 'multi-selected');
    }
    
    content.style.paddingLeft = `${level * 20 + 8}px`;

    const hasChildren = node.isDirectory && (node.children === null || (node.children && node.children.length > 0));
    
    if (hasChildren) {
        const arrow = document.createElement('div');
        arrow.className = 'node-arrow';
        arrow.innerHTML = `<svg class="arrow-icon ${expandedNodes.has(nodeId) ? 'expanded' : ''}" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
            ${expandedNodes.has(nodeId) 
                ? '<path fill-rule="evenodd" clip-rule="evenodd" d="M7.97612 10.0719L12.3334 5.7146L12.9521 6.33332L8.28548 11L7.66676 11L3.0001 6.33332L3.61882 5.7146L7.97612 10.0719Z" fill="currentColor"/>'
                : '<path fill-rule="evenodd" clip-rule="evenodd" d="M10.0719 8.02397L5.7146 3.66666L6.33332 3.04794L11 7.71461V8.33333L6.33332 13L5.7146 12.3813L10.0719 8.02397Z" fill="currentColor"/>'}
        </svg>`;

        arrow.addEventListener('click', async (e) => {
            e.stopPropagation();
            await toggleNode(nodeId, node);
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
        const isExpanded = expandedNodes.has(nodeId);
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

    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'eye-btn';
    eyeBtn.innerHTML = node.excluded 
        ? '<svg viewBox="0 0 16 16"><path d="M8 2C4.5 2 1.5 5 0 8c1.5 3 4.5 6 8 6s6.5-3 8-6c-1.5-3-4.5-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1 1l14 14" stroke="currentColor" stroke-width="1.3"/></svg>'
        : '<svg viewBox="0 0 16 16"><path d="M8 2C4.5 2 1.5 5 0 8c1.5 3 4.5 6 8 6s6.5-3 8-6c-1.5-3-4.5-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

    eyeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pathsToToggle = selectedNodes.has(node.fullPath) 
            ? Array.from(selectedNodes) 
            : [node.fullPath];
        
        vscode.postMessage({ type: 'toggleExcludeMultiple', paths: pathsToToggle });
    });

    actions.appendChild(eyeBtn);

    content.appendChild(icon);
    content.appendChild(name);
    content.appendChild(actions);

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
        
        renderFileTree();

        if (!node.isDirectory && !ctrlPressed && !shiftPressed) {
            vscode.postMessage({ type: 'openFile', path: node.fullPath });
        } else if (node.isDirectory && hasChildren && !ctrlPressed && !shiftPressed) {
            await toggleNode(nodeId, node);
        }
    });

    nodeElement.appendChild(content);

    if (node.isDirectory && expandedNodes.has(nodeId)) {
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
            loadChildren(node, nodeId);
        } else if (node.children && node.children.length > 0) {
            node.children.forEach(child => {
                childrenContainer.appendChild(createTreeNode(child, level + 1, nodeId));
            });
        }

        nodeElement.appendChild(childrenContainer);
    }

    return nodeElement;
}

async function toggleNode(nodeId, node) {
    if (expandedNodes.has(nodeId)) {
        expandedNodes.delete(nodeId);
    } else {
        expandedNodes.add(nodeId);
        if (node && node.children === null) {
            await loadChildren(node, nodeId);
        }
    }
    renderFileTree();
}

initializeEventListeners();
vscode.postMessage({ type: 'getFileTree' });
