'use strict';

/* ============================================================
   VFS  —  Virtual File System (in-memory, serialized encrypted)
   ============================================================ */
const VFS = (() => {
    let _nodes = {};  // id → Node
    let _pos = {};  // parentId → { nodeId: {x, y} }

    function init() {
        _nodes = { root: { id: 'root', type: 'folder', name: '/', parentId: null, ctime: Date.now(), mtime: Date.now() } };
        _pos = { root: {} };
    }

    function fromObj(obj) {
        _nodes = obj.nodes || {};
        _pos = obj.pos || {};
        if (!_nodes.root) _nodes.root = { id: 'root', type: 'folder', name: '/', parentId: null, ctime: Date.now(), mtime: Date.now() };
        if (!_pos.root) _pos.root = {};
        // Integrity repair pass 1: reattach orphaned nodes whose parentId points to non-existent node
        Object.values(_nodes).forEach(n => {
            if (n.id !== 'root' && n.parentId && !_nodes[n.parentId]) {
                console.warn('VFS: orphaned node', n.id, '— reattaching to root');
                n.parentId = 'root';
            }
        });
        // Integrity repair pass 2: detect and break real parent→child cycles
        // For each node walk the ancestor chain; if we revisit any node in the same chain → cycle
        Object.keys(_nodes).forEach(id => {
            if (id === 'root') return;
            const chain = new Set();
            let cur = id;
            while (cur && cur !== 'root') {
                if (chain.has(cur)) {
                    console.warn('VFS: cycle detected at node', cur, '— reattaching to root');
                    _nodes[cur].parentId = 'root';
                    break;
                }
                if (!_nodes[cur]) break;
                chain.add(cur);
                cur = _nodes[cur].parentId;
            }
        });
        // Integrity repair pass 3: prune _pos entries whose parent or child node no longer exists
        for (const pid of Object.keys(_pos)) {
            if (pid !== 'root' && !_nodes[pid]) { delete _pos[pid]; continue; }
            for (const nid of Object.keys(_pos[pid] || {})) {
                if (!_nodes[nid]) delete _pos[pid][nid];
            }
        }
    }

    function toObj() { return { nodes: _nodes, pos: _pos }; }

    function children(pid) { return Object.values(_nodes).filter(n => n.parentId === pid); }

    function getPos(pid, nid) { return (_pos[pid] || {})[nid] || null; }
    function setPos(pid, nid, x, y) {
        if (!_pos[pid]) _pos[pid] = {};
        // Always snap to the current grid so sub-pixel drift and legacy off-grid positions
        // are corrected at write time. Math.round handles both truncation and rounding.
        const sx = 8 + Math.max(0, Math.round((Math.round(x) - 8) / GRID_X)) * GRID_X;
        const sy = 8 + Math.max(0, Math.round((Math.round(y) - 8) / GRID_Y)) * GRID_Y;
        _pos[pid][nid] = { x: sx, y: sy };
    }
    function delPos(pid, nid) { if (_pos[pid]) delete _pos[pid][nid]; }

    function add(nd) {
        if (!nd?.id || nd.id === 'root' || !['file', 'folder'].includes(nd.type)) return;
        _nodes[nd.id] = nd;
        if (!_pos[nd.id] && nd.type === 'folder') _pos[nd.id] = {};
    }

    function remove(id, _visited = new Set()) {
        if (_visited.has(id)) return;
        _visited.add(id);
        const n = _nodes[id]; if (!n) return;
        if (n.type === 'folder') {
            children(id).forEach(c => remove(c.id, _visited));
            delete _pos[id];
        }
        delPos(n.parentId, id);
        delete _nodes[id];
    }

    function rename(id, newName) {
        if (id !== 'root' && _nodes[id]) { _nodes[id].name = newName; _nodes[id].mtime = Date.now(); }
    }

    function move(id, newParentId) {
        const n = _nodes[id]; if (!n || !_nodes[newParentId]) return 'not_found';
        if (id === 'root' || _nodes[newParentId].type !== 'folder') return 'not_found';
        // prevent move into self or descendant — visited Set guards against corrupt-data infinite loops
        let c = newParentId;
        const _mv = new Set();
        while (c) {
            if (c === id) return 'cycle';
            if (_mv.has(c)) break;
            _mv.add(c);
            c = (_nodes[c] || {}).parentId;
        }
        // prevent duplicate name in destination
        if (children(newParentId).some(s => s.id !== id && s.name.toLowerCase() === n.name.toLowerCase())) return 'duplicate';
        delPos(n.parentId, id);
        n.parentId = newParentId;
        n.mtime = Date.now();
        return 'ok';
    }

    function totalSize() {
        return Object.values(_nodes)
            .filter(n => n.type === 'file')
            .reduce((s, n) => s + (Number.isFinite(n.size) ? n.size : 0), 0);
    }

    function breadcrumb(folderId) {
        const path = [], visited = new Set(); let cur = folderId;
        while (cur && !visited.has(cur)) {
            visited.add(cur);
            path.unshift(_nodes[cur]);
            cur = (_nodes[cur] || {}).parentId;
        }
        return path;
    }

    function fullPath(nodeId) {
        const parts = [], visited = new Set();
        let cur = nodeId;
        while (cur) {
            if (visited.has(cur)) break; // cycle guard
            visited.add(cur);
            const n = _nodes[cur];
            if (!n) break;
            if (n.id === 'root') break;
            parts.unshift(n.name);
            cur = n.parentId;
        }
        return '/~/' + (App.container ? App.container.name : '') + (parts.length ? '/' + parts.join('/') : '');
    }

    function autoPos(pid, idx, area) {
        const W = (area && area.clientWidth) || 800,
            cols = Math.max(1, Math.floor((W - 16) / GRID_X));
        // Build set of occupied grid cells
        const occupied = new Set();
        Object.values(_pos[pid] || {}).forEach(p => {
            const cx = Math.round((p.x - 8) / GRID_X);
            const cy = Math.round((p.y - 8) / GRID_Y);
            occupied.add(`${cx}_${cy}`);
        });
        // Row-by-row scan for first free cell
        for (let row = 0; row < 10000; row++) {
            for (let col = 0; col < cols; col++) {
                if (!occupied.has(`${col}_${row}`)) return { x: 8 + col * GRID_X, y: 8 + row * GRID_Y };
            }
        }
        const col = idx % cols, row = Math.floor(idx / cols);
        return { x: 8 + col * GRID_X, y: 8 + row * GRID_Y };
    }

    function node(id) { return _nodes[id]; }

    function hasChildNamed(pid, name) {
        const lower = name.toLowerCase();
        return children(pid).some(n => n.name.toLowerCase() === lower);
    }

    function wouldCycle(id, newParentId) {
        let c = newParentId;
        const _wc = new Set();
        while (c) {
            if (c === id) return true;
            if (_wc.has(c)) break;
            _wc.add(c);
            c = (_nodes[c] || {}).parentId;
        }
        return false;
    }

    function remapPositions(oldGX, oldGY, newGX, newGY) {
        if (oldGX === newGX && oldGY === newGY) return;
        for (const pid of Object.keys(_pos)) {
            const map = _pos[pid];
            for (const nid of Object.keys(map)) {
                const p = map[nid];
                const cx = Math.round((p.x - 8) / oldGX);
                const cy = Math.round((p.y - 8) / oldGY);
                map[nid] = { x: 8 + cx * newGX, y: 8 + cy * newGY };
            }
        }
    }

    return {
        init, fromObj, toObj, children, node, add, remove, rename, move, wouldCycle,
        getPos, setPos, delPos, totalSize, breadcrumb, fullPath, autoPos, hasChildNamed,
        remapPositions
    };
})();
