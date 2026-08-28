const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'obsidian') {
        return {
            Plugin: class Plugin {},
            Modal: class Modal {},
            FuzzySuggestModal: class FuzzySuggestModal {},
            Menu: class Menu {
                constructor() {
                    this.items = [];
                }
                addItem(cb) {
                    const item = {
                        setTitle(t) { this.title = t; return this; },
                        setIcon(i) { this.icon = i; return this; },
                        onClick(fn) { this.action = fn; return this; }
                    };
                    cb(item);
                    this.items.push(item);
                    return this;
                }
                showAtMouseEvent(e) {
                    this.shownAt = e;
                }
            },
            Keymap: {
                isModEvent(evt) {
                    return Boolean(evt && (evt.ctrlKey || evt.metaKey));
                }
            },
            debounce: fn => fn
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
        this.classList = createClassList(this.cls);
    }

    appendChild(child) {
        if (child && typeof child === 'object') {
            child.parent = this;
        }
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

    getAttribute(name) {
        return this.attr[name] !== undefined ? this.attr[name] : null;
    }

    setAttribute(name, val) {
        this.attr[name] = val;
    }

    setAttr(key, val) {
        this.attr[key] = val;
    }

    hasAttribute(name) {
        return this.attr[name] !== undefined;
    }

    empty() {
        this.children = [];
    }

    closest(selector) {
        let current = this;
        while (current) {
            if (selector === 'a' && current.tag === 'a') return current;
            if (selector.startsWith('.') && current.classList.contains(selector.slice(1))) return current;
            current = current.parent;
        }
        return null;
    }

    querySelectorAll(selector) {
        const matches = [];
        const traverse = node => {
            if (!node || typeof node !== 'object') return;
            let match = false;
            if (selector === 'a' && node.tag === 'a') {
                match = true;
            } else if (selector.startsWith('.') && node.classList && node.classList.contains(selector.slice(1))) {
                match = true;
            } else if (selector.includes('.')) {
                const [tag, cls] = selector.split('.');
                if ((!tag || node.tag === tag) && node.classList && node.classList.contains(cls)) {
                    match = true;
                }
            }
            if (match) {
                matches.push(node);
            }
            if (Array.isArray(node.children)) {
                node.children.forEach(traverse);
            }
        };
        this.children.forEach(traverse);
        return matches;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    remove() {
        if (this.parent) {
            const index = this.parent.children.indexOf(this);
            if (index >= 0) this.parent.children.splice(index, 1);
            this.parent = null;
        }
    }
}

global.document = {
    body: {
        classList: createClassList('theme-dark')
    },
    createTextNode(text) {
        return { type: 'text', text: String(text) };
    },
    querySelectorAll() {
        return [];
    }
};

global.createDiv = function (options = {}) {
    return new TestElement('div', options);
};

const InfoboxPlugin = require('../main.js');

function render(value) {
    const opened = [];
    const plugin = new InfoboxPlugin();
    plugin.app = {
        workspace: {
            openLinkText(target, sourcePath, isMod) {
                opened.push({ target, sourcePath, isMod });
            }
        }
    };

    const parent = new TestElement('span');
    plugin.renderInlineText(parent, value, { path: 'Characters/Varka.md' });
    return { parent, opened };
}

function linksOf(parent) {
    return parent.querySelectorAll('a');
}

// 1. Basic wikilink fallback rendering and direct click
{
    const { parent, opened } = render('Region: [[Mondstadt]]');
    const links = linksOf(parent);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'Mondstadt');
    assert.strictEqual(links[0].attr.href, 'Mondstadt');
    assert.strictEqual(links[0].attr['data-href'], 'Mondstadt');

    links[0].listeners.click({ preventDefault() {} });
    assert.deepStrictEqual(opened, [{ target: 'Mondstadt', sourcePath: 'Characters/Varka.md', isMod: false }]);
}

// 2. Wikilink with alias and mod click (Ctrl/Cmd)
{
    const { parent, opened } = render('[[Knights of Favonius|the Knights]]');
    const links = linksOf(parent);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'the Knights');
    assert.strictEqual(links[0].attr.href, 'Knights of Favonius');
    assert.strictEqual(links[0].attr['data-href'], 'Knights of Favonius');

    links[0].listeners.click({ preventDefault() {}, ctrlKey: true });
    assert.deepStrictEqual(opened, [{ target: 'Knights of Favonius', sourcePath: 'Characters/Varka.md', isMod: true }]);
}

// 3. Unquoted YAML nested array formats
{
    const { parent } = render([['Mondstadt']]);
    const links = linksOf(parent);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'Mondstadt');
    assert.strictEqual(links[0].attr.href, 'Mondstadt');
}

{
    const { parent } = render([['Knights of Favonius|the Knights']]);
    const links = linksOf(parent);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'the Knights');
    assert.strictEqual(links[0].attr.href, 'Knights of Favonius');
}

// 4. Panel delegation: left-click, auxclick (middle click), mouseover (hover preview), and contextmenu
{
    const opened = [];
    const hovered = [];
    const plugin = new InfoboxPlugin();

    const file = { path: 'Characters/Varka.md', basename: 'Varka' };
    const containerEl = new TestElement('div');
    const leafView = {
        getViewType: () => 'markdown',
        file,
        containerEl
    };
    const leaf = { view: leafView };

    plugin.app = {
        workspace: {
            openLinkText(target, sourcePath, newLeaf) {
                opened.push({ target, sourcePath, newLeaf });
            },
            trigger(eventName, payload) {
                if (eventName === 'hover-link') {
                    hovered.push(payload);
                }
            }
        },
        metadataCache: {
            getFileCache() {
                return {
                    frontmatter: {
                        infobox: {
                            title: '[[Varka]]',
                            subtitle: 'Grand Master of [[Knights of Favonius]]',
                            tags: ['favonius', 'mondstadt'],
                            fields: [
                                { Region: '[[Mondstadt]]' },
                                { Website: '[External](https://example.com)' }
                            ]
                        }
                    }
                };
            },
            getFirstLinkpathDest() { return null; }
        },
        vault: {
            getResourcePath() { return ''; }
        }
    };

    plugin.processLeaf(leaf);

    const panel = containerEl.querySelector('.infobox-panel');
    assert(panel, 'infobox-panel should be created');

    const links = panel.querySelectorAll('a');
    assert(links.length >= 3, 'Links should be rendered');

    const mondstadtLink = links.find(l => l.getAttribute('data-href') === 'Mondstadt');
    assert(mondstadtLink, 'Mondstadt link should exist');

    // 4a. Left click normal
    let prevented = false;
    let stopped = false;
    panel.listeners.click({
        target: mondstadtLink,
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; }
    });
    assert(prevented, 'Click should prevent default');
    assert.deepStrictEqual(opened[0], { target: 'Mondstadt', sourcePath: 'Characters/Varka.md', newLeaf: false });

    // 4b. Left click with modifier key (Ctrl/Cmd)
    panel.listeners.click({
        target: mondstadtLink,
        ctrlKey: true,
        preventDefault() {},
        stopPropagation() {}
    });
    assert.deepStrictEqual(opened[1], { target: 'Mondstadt', sourcePath: 'Characters/Varka.md', newLeaf: true });

    // 4c. Middle-click (auxclick with button 1)
    panel.listeners.auxclick({
        button: 1,
        target: mondstadtLink,
        preventDefault() {},
        stopPropagation() {}
    });
    assert.deepStrictEqual(opened[2], { target: 'Mondstadt', sourcePath: 'Characters/Varka.md', newLeaf: 'tab' });

    // 4d. Mouseover (Page Preview hover-link trigger)
    panel.listeners.mouseover({
        target: mondstadtLink
    });
    assert.strictEqual(hovered.length, 1);
    assert.strictEqual(hovered[0].source, 'infobox');
    assert.strictEqual(hovered[0].linktext, 'Mondstadt');
    assert.strictEqual(hovered[0].sourcePath, 'Characters/Varka.md');
    assert.strictEqual(hovered[0].targetEl, mondstadtLink);

    // 4e. External link should NOT be intercepted by internal link handlers
    const extLink = new TestElement('a', {
        cls: 'external-link',
        attr: { href: 'https://example.com' }
    });
    panel.appendChild(extLink);
    const openedBefore = opened.length;
    panel.listeners.click({
        target: extLink,
        preventDefault() {},
        stopPropagation() {}
    });
    assert.strictEqual(opened.length, openedBefore, 'External link should not call openLinkText');

    // 4f. Tag click handling
    let searchOpened = null;
    plugin.app.internalPlugins = {
        getPluginById(id) {
            if (id === 'global-search') {
                return {
                    instance: {
                        openGlobalSearch(query) {
                            searchOpened = query;
                        }
                    }
                };
            }
            return null;
        }
    };

    const tagLink = panel.querySelectorAll('.infobox-tag')[0];
    assert(tagLink, 'Tag link should exist');
    panel.listeners.click({
        target: tagLink,
        preventDefault() {},
        stopPropagation() {}
    });
    assert.strictEqual(searchOpened, 'tag:#favonius', 'Tag click should open global search');
}

// 5. MarkdownRenderer.render path testing
{
    const obsidianMod = require('obsidian');
    obsidianMod.MarkdownRenderer = {
        async render(app, markdown, el, sourcePath, component) {
            const p = el.createEl('p');
            p.createEl('a', {
                cls: 'internal-link',
                text: 'Fontaine',
                attr: {
                    href: 'Fontaine',
                    'data-href': 'Fontaine'
                }
            });
        }
    };

    const plugin = new InfoboxPlugin();
    plugin.app = {
        workspace: {
            openLinkText() {}
        }
    };

    const parent = new TestElement('span');
    plugin.renderInlineText(parent, '[[Fontaine]]', { path: 'Characters/Furina.md' });

    // Wait for the async render promise microtask
    setImmediate(() => {
        const links = parent.querySelectorAll('a');
        assert.strictEqual(links.length, 1);
        assert.strictEqual(links[0].text, 'Fontaine');
        assert(links[0].classList.contains('infobox-link'));
        assert(links[0].classList.contains('internal-link'));
        console.log('infobox-link-rendering tests passed');
    });
}
