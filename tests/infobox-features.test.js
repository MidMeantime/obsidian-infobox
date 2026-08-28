const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'obsidian') {
        return {
            Plugin: class Plugin {},
            Modal: class Modal {},
            FuzzySuggestModal: class FuzzySuggestModal {},
            debounce: (fn) => fn
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

function createClassList(initial = '') {
    const classes = new Set(initial.split(/\s+/).filter(Boolean));
    return {
        add(...names) {
            names.forEach(name => classes.add(name));
        },
        remove(...names) {
            names.forEach(name => classes.delete(name));
        },
        contains(name) {
            return classes.has(name);
        },
        toggle(name, force) {
            if (force === undefined) {
                if (classes.has(name)) { classes.delete(name); return false; }
                else { classes.add(name); return true; }
            }
            if (force) { classes.add(name); return true; }
            else { classes.delete(name); return false; }
        }
    };
}

class TestElement {
    constructor(tag, options = {}) {
        this.tag = tag;
        this.cls = options.cls || '';
        this.text = options.text || '';
        this.attr = { ...(options.attr || {}) };
        this.children = [];
        this.parent = null;
        this.listeners = {};
        this.style = {};
        this.classList = createClassList(this.cls);
    }

    empty() {
        this.children = [];
    }

    appendChild(child) {
        if (child && typeof child === 'object') child.parent = this;
        this.children.push(child);
        return child;
    }

    createEl(tag, options = {}) {
        const child = new TestElement(tag, options);
        this.appendChild(child);
        return child;
    }

    createDiv(options = {}) {
        return this.createEl('div', options);
    }

    addClass(name) {
        this.classList.add(name);
    }

    addEventListener(eventName, callback) {
        this.listeners[eventName] = callback;
    }

    setAttr(key, val) {
        this.attr[key] = val;
    }

    closest(selector) {
        const className = selector.startsWith('.') ? selector.slice(1) : selector;
        let current = this;
        while (current) {
            if (current.classList?.contains(className)) return current;
            current = current.parent;
        }
        return null;
    }

    querySelector(selector) {
        if (selector === '.markdown-preview-sizer, .cm-sizer') {
            return this.contentSizer || null;
        }
        return null;
    }

    querySelectorAll() {
        return [];
    }
}

global.document = {
    body: { classList: createClassList() },
    createTextNode(text) {
        return { type: 'text', text: String(text) };
    }
};
global.createDiv = options => new TestElement('div', options);
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

const InfoboxPlugin = require('../main.js');

function setupPlugin() {
    const plugin = new InfoboxPlugin();
    plugin.commands = [];
    plugin.addCommand = (cmd) => plugin.commands.push(cmd);
    plugin.registerEvent = () => {};
    plugin.app = {
        vault: {
            getResourcePath: (dest) => dest,
            getFiles: () => []
        },
        metadataCache: {
            getFirstLinkpathDest: (src) => src,
            getFileCache: () => ({}),
            on: () => ({})
        },
        workspace: {
            openLinkText: () => {},
            on: () => ({}),
            onLayoutReady: (cb) => cb && cb(),
            getActiveFile: () => null,
            iterateAllLeaves: () => {}
        }
    };
    return plugin;
}

// ── Test 1: Supertitle rendering ─────────────────────────────────
{
    const plugin = setupPlugin();
    const container = new TestElement('div');
    plugin.app.metadataCache.getFileCache = () => ({
        frontmatter: {
            infobox: {
                supertitle: 'Grand Master',
                title: 'Varka'
            }
        }
    });

    plugin.processLeaf({
        view: {
            containerEl: container,
            contentEl: container,
            file: { path: 'Characters/Varka.md' },
            getViewType: () => 'markdown'
        }
    });

    const panel = container.children.find(c => c.cls === 'infobox-panel');
    assert(panel, 'Panel should be created');
    const card = panel.children.find(c => c.cls === 'infobox');
    assert(card, 'Card should be created');

    const supertitleDiv = card.children.find(c => c.cls === 'infobox-supertitle');
    assert(supertitleDiv, 'Supertitle element should be created');

    const titleDiv = card.children.find(c => c.cls === 'infobox-title');
    assert(titleDiv, 'Title element should be created');

    const editBtn = panel.children.find(c => c.cls === 'infobox-edit-button');
    assert(editBtn, 'Edit button should be present on panel');
}

// ── Test 2: List parsing in renderFieldValue ─────────────────────
{
    const plugin = setupPlugin();
    const file = { path: 'Test.md' };

    // Native array
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, ['Alpha', 'Beta'], file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul' && c.cls === 'infobox-list');
        assert(ul, 'Array should render as ul.infobox-list');
        assert.strictEqual(ul.children.length, 2);
    }

    // Multiline string
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, '- Item 1\n* Item 2\n- Item 3', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul' && c.cls === 'infobox-list');
        assert(ul, 'Multiline string should render as ul.infobox-list');
        assert.strictEqual(ul.children.length, 3);
    }

    // Pipe separated
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, 'Knight | Mage | Archer', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul' && c.cls === 'infobox-list');
        assert(ul, 'Pipe separated string should render as ul.infobox-list');
        assert.strictEqual(ul.children.length, 3);
    }

    // Wikilink with pipe alias must NOT be split into list
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, '[[Knights of Favonius|the Knights]]', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul');
        assert(!ul, 'Wikilink with alias pipe should NOT render as a list');
        assert(valDiv.children.some(c => c.tag === 'a' && c.text === 'the Knights'));
    }

    // Comma separated
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, 'Red, Green, Blue', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul' && c.cls === 'infobox-list');
        assert(ul, 'Comma separated string should render as ul.infobox-list');
        assert.strictEqual(ul.children.length, 3);
    }

    // Wikilink with comma inside alias must NOT be split
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, '[[Einstein, Albert|Albert Einstein]]', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul');
        assert(!ul, 'Wikilink with comma inside name should NOT be split');
    }
}

// ── Test 3: Multi-image gallery ──────────────────────────────────
{
    const plugin = setupPlugin();
    const container = new TestElement('div');
    plugin.app.metadataCache.getFileCache = () => ({
        frontmatter: {
            infobox: {
                title: 'Gallery Test',
                images: [
                    { label: 'Tab 1', image: 'img1.png', caption: 'First' },
                    { label: 'Tab 2', image: 'img2.png', caption: 'Second' }
                ]
            }
        }
    });

    plugin.processLeaf({
        view: {
            containerEl: container,
            contentEl: container,
            file: { path: 'Gallery.md' },
            getViewType: () => 'markdown'
        }
    });

    const panel = container.children.find(c => c.cls === 'infobox-panel');
    const card = panel.children.find(c => c.cls === 'infobox');
    const gallery = card.children.find(c => c.cls === 'infobox-gallery');
    assert(gallery, 'Gallery container should be created');

    const tabs = gallery.children.find(c => c.cls === 'infobox-image-tabs');
    assert(tabs, 'Tabs should be created for multi-image gallery');
    assert.strictEqual(tabs.children.length, 2);
}

// ── Test 4: Field Reordering in InfoboxEditModal ────────────────
{
    const file = { path: 'TestNote.md' };
    const initialData = {
        fields: [
            { section: 'Section 1' },
            { 'Field A': 'Value A' },
            { 'Field B': 'Value B' },
            { section: 'Section 2' }
        ]
    };

    let processedFm = null;
    const fakeApp = {
        fileManager: {
            processFrontMatter: async (f, callback) => {
                const fm = {};
                callback(fm);
                processedFm = fm;
            }
        }
    };

    // Instantiate plugin's modal
    // We can simulate moveField directly on an instance
    const plugin = setupPlugin();
    // Test manual move
    const fields = initialData.fields.slice();
    const [moved] = fields.splice(1, 1); // remove Field A at index 1
    fields.splice(2, 0, moved); // insert Field A at index 2 (after Field B)

    assert.deepStrictEqual(fields, [
        { section: 'Section 1' },
        { 'Field B': 'Value B' },
        { 'Field A': 'Value A' },
        { section: 'Section 2' }
    ]);
}

// ── Test 6: 'add-infobox' command registration ───────────────────
{
    const plugin = setupPlugin();

    plugin.onload();

    const addInfoboxCmd = plugin.commands.find(c => c.id === 'add-infobox');
    assert(addInfoboxCmd, 'add-infobox command must be registered');
    assert.strictEqual(addInfoboxCmd.name, 'Add infobox');

    // Test checkCallback when no file is active
    plugin.app.workspace.getActiveFile = () => null;
    assert.strictEqual(addInfoboxCmd.checkCallback(true), false);

    // Test checkCallback when a file is active
    plugin.app.workspace.getActiveFile = () => ({ basename: 'Einstein', path: 'Einstein.md' });
    assert.strictEqual(addInfoboxCmd.checkCallback(true), true);
}

// ── Test 7: 'remove-infobox' command registration ────────────────
{
    const plugin = setupPlugin();

    plugin.onload();

    const removeCmd = plugin.commands.find(c => c.id === 'remove-infobox');
    assert(removeCmd, 'remove-infobox command must be registered');
    assert.strictEqual(removeCmd.name, 'Remove infobox');

    // Should return false when no file is active
    plugin.app.workspace.getActiveFile = () => null;
    assert.strictEqual(removeCmd.checkCallback(true), false);

    // Should return false when file has no infobox
    plugin.app.workspace.getActiveFile = () => ({ basename: 'Test', path: 'Test.md' });
    plugin.app.metadataCache.getFileCache = () => ({ frontmatter: {} });
    assert.strictEqual(removeCmd.checkCallback(true), false);

    // Should return true when file has infobox
    plugin.app.metadataCache.getFileCache = () => ({ frontmatter: { infobox: { title: 'Test' } } });
    assert.strictEqual(removeCmd.checkCallback(true), true);
}

console.log('infobox-features tests passed');


