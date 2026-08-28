'use strict';

const obsidian = require('obsidian');
const Plugin = obsidian.Plugin;
const Modal = obsidian.Modal || class Modal { };
const FuzzySuggestModal = obsidian.FuzzySuggestModal || class FuzzySuggestModal { };
const debounce = obsidian.debounce || ((fn, delay) => fn);
const MarkdownRenderer = obsidian.MarkdownRenderer;

/*
 * Infobox plugin — reads structured data from YAML frontmatter and renders
 * a Wikipedia-style panel pinned to the right side of the reading pane.
 *
 * Usage — add an `infobox:` block to your note's frontmatter:
 *
 *   ---
 *   infobox:
 *     supertitle: Professor
 *     title: Albert Einstein
 *     subtitle: Theoretical Physicist
 *     image: einstein.jpg
 *     caption: Photograph from 1921
 *     tags: [science, physics]
 *     fields:
 *       - section: Personal
 *       - Born: March 14, 1879
 *       - Died: April 18, 1955
 *       - section: Career
 *       - Field: Theoretical physics
 *       - Known for: General relativity
 *   ---
 */

function splitOutsideWikilinks(str, delimiter) {
    const tokens = [];
    let current = '';
    let inLink = 0;
    for (let i = 0; i < str.length; i++) {
        if (str[i] === '[' && str[i + 1] === '[') {
            inLink++;
            current += '[[';
            i++;
        } else if (str[i] === ']' && str[i + 1] === ']') {
            if (inLink > 0) inLink--;
            current += ']]';
            i++;
        } else if (str[i] === delimiter && inLink === 0) {
            tokens.push(current.trim());
            current = '';
        } else {
            current += str[i];
        }
    }
    if (current.trim().length > 0) {
        tokens.push(current.trim());
    }
    return tokens.filter(Boolean);
}

class InfoboxEditModal extends Modal {
    constructor(app, file, currentData) {
        super(app);
        this.setTitle('Edit Infobox');
        this.file = file;
        this.currentData = currentData;
        this.debouncedSave = debounce(this.updateYaml.bind(this), 300, true);
        this.debouncedSaveFields = debounce(this.saveFields.bind(this), 300, true);
        this.debouncedSaveGallery = debounce(this.saveGallery.bind(this), 300, true);
        this.debouncedSaveTags = debounce(this.saveTags.bind(this), 300, true);
        this.draggedIndex = null;
        this.draggedTagIndex = null;
    }

    async updateYaml(key, value) {
        await this.app.fileManager.processFrontMatter(this.file, frontmatter => {
            if (!frontmatter.infobox) frontmatter.infobox = {};
            if (value === '' || value == null) {
                delete frontmatter.infobox[key];
            } else {
                frontmatter.infobox[key] = value;
            }
        });
    }

    async saveFields() {
        await this.app.fileManager.processFrontMatter(this.file, frontmatter => {
            if (!frontmatter.infobox) frontmatter.infobox = {};
            frontmatter.infobox.fields = JSON.parse(JSON.stringify(this.currentData.fields || []));
        });
    }

    async saveGallery() {
        await this.app.fileManager.processFrontMatter(this.file, frontmatter => {
            if (!frontmatter.infobox) frontmatter.infobox = {};
            if (Array.isArray(this.currentData.images) && this.currentData.images.length > 0) {
                frontmatter.infobox.images = JSON.parse(JSON.stringify(this.currentData.images));
                delete frontmatter.infobox.image;
                delete frontmatter.infobox.caption;
            } else {
                delete frontmatter.infobox.images;
                delete frontmatter.infobox.image;
                delete frontmatter.infobox.caption;
            }
        });
    }

    async saveTags() {
        await this.app.fileManager.processFrontMatter(this.file, frontmatter => {
            if (!frontmatter.infobox) frontmatter.infobox = {};
            if (Array.isArray(this.currentData.tags) && this.currentData.tags.length > 0) {
                frontmatter.infobox.tags = JSON.parse(JSON.stringify(this.currentData.tags));
            } else {
                delete frontmatter.infobox.tags;
            }
            if (this.currentData.showTags !== undefined) {
                frontmatter.infobox.showTags = this.currentData.showTags;
            }
        });
    }

    addField(defaultObj) {
        if (!this.currentData.fields) this.currentData.fields = [];
        this.currentData.fields.push(defaultObj);
        this.saveFields().then(() => this.renderFieldsEditor());
    }

    removeField(index) {
        if (!this.currentData.fields) return;
        this.currentData.fields.splice(index, 1);
        this.saveFields().then(() => this.renderFieldsEditor());
    }

    moveField(fromIndex, toIndex) {
        if (!this.currentData.fields) return;
        if (fromIndex < 0 || fromIndex >= this.currentData.fields.length) return;
        if (toIndex < 0 || toIndex >= this.currentData.fields.length) return;

        const [item] = this.currentData.fields.splice(fromIndex, 1);
        this.currentData.fields.splice(toIndex, 0, item);
        this.saveFields().then(() => this.renderFieldsEditor());
    }

    moveTag(fromIndex, toIndex, container) {
        if (!Array.isArray(this.currentData.tags)) return;
        if (fromIndex < 0 || fromIndex >= this.currentData.tags.length) return;
        if (toIndex < 0 || toIndex >= this.currentData.tags.length) return;

        const [tag] = this.currentData.tags.splice(fromIndex, 1);
        this.currentData.tags.splice(toIndex, 0, tag);
        this.debouncedSaveTags();
        this.renderTagsEditor(container);
    }

    renderFieldsEditor() {
        this.fieldsContainer.empty();
        const fields = this.currentData.fields || [];

        fields.forEach((item, index) => {
            if (!item || typeof item !== 'object') return;
            const key = Object.keys(item)[0];
            const val = item[key];
            const isSection = key.toLowerCase() === 'section';
            const rowCls = isSection
                ? 'infobox-edit-field-row is-section'
                : 'infobox-edit-field-row is-label';

            const row = this.fieldsContainer.createDiv({ cls: rowCls });
            row.setAttribute('draggable', 'true');

            // Drag handle
            row.createEl('span', {
                text: '⠿',
                cls: 'infobox-edit-drag-handle',
                attr: {
                    title: 'Drag to reorder',
                    'aria-label': 'Drag to reorder'
                }
            });

            // Reorder buttons for keyboard & accessibility
            const reorderBtns = row.createDiv({ cls: 'infobox-edit-reorder-btns' });
            const moveUpBtn = reorderBtns.createEl('button', {
                text: '▲',
                cls: 'infobox-edit-move-btn',
                attr: {
                    'aria-label': 'Move field up',
                    title: 'Move field up',
                    type: 'button'
                }
            });
            if (index === 0) moveUpBtn.disabled = true;
            moveUpBtn.addEventListener('click', () => this.moveField(index, index - 1));

            const moveDownBtn = reorderBtns.createEl('button', {
                text: '▼',
                cls: 'infobox-edit-move-btn',
                attr: {
                    'aria-label': 'Move field down',
                    title: 'Move field down',
                    type: 'button'
                }
            });
            if (index === fields.length - 1) moveDownBtn.disabled = true;
            moveDownBtn.addEventListener('click', () => this.moveField(index, index + 1));

            // Drag & Drop events
            row.addEventListener('dragstart', e => {
                this.draggedIndex = index;
                row.classList.add('is-dragging');
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(index));
                }
            });

            row.addEventListener('dragend', () => {
                this.draggedIndex = null;
                row.classList.remove('is-dragging');
                this.fieldsContainer.querySelectorAll('.is-dragover').forEach(el => el.classList.remove('is-dragover'));
            });

            row.addEventListener('dragover', e => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                if (!row.classList.contains('is-dragover')) {
                    row.classList.add('is-dragover');
                }
            });

            row.addEventListener('dragleave', () => {
                row.classList.remove('is-dragover');
            });

            row.addEventListener('drop', e => {
                e.preventDefault();
                row.classList.remove('is-dragover');
                if (this.draggedIndex !== null && this.draggedIndex !== index) {
                    this.moveField(this.draggedIndex, index);
                }
            });

            if (isSection) {
                const secInput = row.createEl('input', {
                    type: 'text',
                    cls: 'infobox-edit-field-section-input',
                    value: val ?? '',
                    attr: {
                        placeholder: 'Section title',
                        'aria-label': 'Section title'
                    }
                });

                secInput.addEventListener('input', e => {
                    this.currentData.fields[index] = { section: e.target.value };
                    this.debouncedSaveFields();
                });
            } else {
                const labelInput = row.createEl('input', {
                    type: 'text',
                    cls: 'infobox-edit-field-label-input',
                    value: key ?? '',
                    attr: {
                        placeholder: 'Label',
                        'aria-label': 'Field label'
                    }
                });

                const valInput = row.createEl('textarea', {
                    cls: 'infobox-edit-field-val-input',
                    attr: {
                        placeholder: 'Value (supports [[links]], lists, multiline)',
                        'aria-label': 'Field value'
                    }
                });
                valInput.value = val ?? '';

                labelInput.addEventListener('change', e => {
                    const newKey = e.target.value.trim() || 'Label';
                    this.currentData.fields[index] = { [newKey]: valInput.value };
                    this.saveFields().then(() => this.renderFieldsEditor());
                });

                valInput.addEventListener('input', e => {
                    this.currentData.fields[index] = { [labelInput.value]: e.target.value };
                    this.debouncedSaveFields();
                });
            }

            const removeBtn = row.createEl('button', {
                text: '✕',
                cls: 'infobox-edit-remove-btn',
                attr: {
                    'aria-label': 'Delete field',
                    title: 'Delete field',
                    type: 'button'
                }
            });
            removeBtn.addEventListener('click', () => this.removeField(index));
        });
    }

    renderGalleryEditor(container) {
        container.empty();
        const images = this.currentData.images || [];

        if (images.length === 0) {
            container.createEl('span', {
                text: 'No images added yet.',
                cls: 'infobox-edit-empty-notice'
            });
        }

        images.forEach((entry, index) => {
            const card = container.createDiv({ cls: 'infobox-edit-gallery-item' });

            const header = card.createDiv({ cls: 'infobox-edit-gallery-header' });
            header.createEl('span', { text: images.length > 1 ? `Image ${index + 1}` : 'Image' });

            const removeBtn = header.createEl('button', {
                text: '✕',
                cls: 'infobox-edit-remove-btn',
                attr: {
                    'aria-label': 'Remove image',
                    title: 'Remove image',
                    type: 'button'
                }
            });
            removeBtn.addEventListener('click', () => {
                this.currentData.images.splice(index, 1);
                this.saveGallery().then(() => this.renderGalleryEditor(container));
            });

            // Tab label
            const labelRow = card.createDiv({ cls: 'infobox-edit-gallery-row' });
            labelRow.createEl('span', { text: 'Tab label:', cls: 'infobox-edit-label' });
            const labelInput = labelRow.createEl('input', {
                type: 'text',
                value: entry.label || '',
                attr: { placeholder: `Image ${index + 1} (optional)`, 'aria-label': 'Tab label' }
            });
            labelInput.addEventListener('input', e => {
                entry.label = e.target.value;
                this.debouncedSaveGallery();
            });

            // Image path + browse
            const pathRow = card.createDiv({ cls: 'infobox-edit-gallery-row' });
            pathRow.createEl('span', { text: 'Source:', cls: 'infobox-edit-label' });
            const pathInput = pathRow.createEl('input', {
                type: 'text',
                value: entry.image || '',
                attr: { placeholder: 'Image file or URL', 'aria-label': 'Image path' }
            });
            pathInput.addEventListener('input', e => {
                entry.image = e.target.value;
                this.debouncedSaveGallery();
            });

            const browseBtn = pathRow.createEl('button', {
                text: 'Browse',
                attr: { 'aria-label': 'Browse vault images', type: 'button' }
            });
            browseBtn.addEventListener('click', () => {
                new ImageSuggestModal(this.app, chosenPath => {
                    pathInput.value = chosenPath;
                    entry.image = chosenPath;
                    this.debouncedSaveGallery();
                }).open();
            });

            // Caption
            const captionRow = card.createDiv({ cls: 'infobox-edit-gallery-row' });
            captionRow.createEl('span', { text: 'Caption:', cls: 'infobox-edit-label' });
            const captionInput = captionRow.createEl('input', {
                type: 'text',
                value: entry.caption || '',
                attr: { placeholder: 'Image caption', 'aria-label': 'Image caption' }
            });
            captionInput.addEventListener('input', e => {
                entry.caption = e.target.value;
                this.debouncedSaveGallery();
            });
        });

        const addImgBtn = container.createEl('button', {
            text: '+ Add image',
            attr: { 'aria-label': 'Add image', type: 'button' }
        });
        addImgBtn.addEventListener('click', () => {
            if (!this.currentData.images) this.currentData.images = [];
            this.currentData.images.push({ label: '', image: '', caption: '' });
            this.saveGallery().then(() => this.renderGalleryEditor(container));
        });
    }

    renderTagsEditor(container) {
        container.empty();

        const tagsContainer = container.createDiv({ cls: 'infobox-edit-tags-container' });
        const tags = Array.isArray(this.currentData.tags) ? this.currentData.tags : [];

        if (tags.length === 0) {
            tagsContainer.createEl('span', {
                text: 'No tags added yet.',
                cls: 'infobox-edit-empty-notice'
            });
        } else {
            tags.forEach((tag, idx) => {
                const pill = tagsContainer.createDiv({ cls: 'infobox-edit-tag-pill' });
                pill.setAttribute('draggable', 'true');
                pill.setAttribute('title', 'Drag to reorder tag');

                // Drag & drop events for tag pill
                pill.addEventListener('dragstart', e => {
                    this.draggedTagIndex = idx;
                    pill.classList.add('is-dragging');
                    if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', String(idx));
                    }
                });

                pill.addEventListener('dragend', () => {
                    this.draggedTagIndex = null;
                    pill.classList.remove('is-dragging');
                    tagsContainer.querySelectorAll('.is-dragover').forEach(el => el.classList.remove('is-dragover'));
                });

                pill.addEventListener('dragover', e => {
                    e.preventDefault();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                    if (!pill.classList.contains('is-dragover')) {
                        pill.classList.add('is-dragover');
                    }
                });

                pill.addEventListener('dragleave', () => {
                    pill.classList.remove('is-dragover');
                });

                pill.addEventListener('drop', e => {
                    e.preventDefault();
                    pill.classList.remove('is-dragover');
                    if (this.draggedTagIndex !== null && this.draggedTagIndex !== idx) {
                        this.moveTag(this.draggedTagIndex, idx, container);
                    }
                });

                pill.createEl('span', { text: `#${tag}` });
                const removeBtn = pill.createEl('button', {
                    text: '✕',
                    cls: 'infobox-edit-tag-remove',
                    attr: {
                        'aria-label': `Remove tag ${tag}`,
                        title: `Remove tag ${tag}`,
                        type: 'button'
                    }
                });
                removeBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    this.currentData.tags.splice(idx, 1);
                    this.debouncedSaveTags();
                    this.renderTagsEditor(container);
                });
            });
        }

        // Input row to add new tags
        const inputRow = container.createDiv({ cls: 'infobox-edit-tag-input-row' });
        const tagInput = inputRow.createEl('input', {
            type: 'text',
            attr: {
                placeholder: 'Add tag (press Enter or comma)...',
                'aria-label': 'Add tag'
            }
        });

        const addTag = () => {
            const val = tagInput.value.trim().replace(/^#+/, '').replace(/,+$/, '');
            if (!val) return;
            const newTags = val.split(/[\s,]+/).map(t => t.trim().replace(/^#+/, '')).filter(Boolean);
            if (!this.currentData.tags || !Array.isArray(this.currentData.tags)) {
                this.currentData.tags = [];
            }
            newTags.forEach(t => {
                if (!this.currentData.tags.includes(t)) {
                    this.currentData.tags.push(t);
                }
            });
            tagInput.value = '';
            this.debouncedSaveTags();
            this.renderTagsEditor(container);
        };

        tagInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag();
            }
        });

        const addBtn = inputRow.createEl('button', {
            text: '+ Add',
            attr: { 'aria-label': 'Add tag', type: 'button' }
        });
        addBtn.addEventListener('click', addTag);

        // Show tags toggle
        const toggleRow = container.createDiv({ cls: 'infobox-edit-toggle-row' });
        const toggleLabel = toggleRow.createEl('label', {
            cls: 'infobox-edit-toggle-label'
        });
        const checkbox = toggleLabel.createEl('input', { type: 'checkbox' });
        checkbox.checked = this.currentData.showTags !== false;
        toggleLabel.createSpan({ text: 'Show tags in infobox' });

        checkbox.addEventListener('change', () => {
            this.currentData.showTags = checkbox.checked;
            this.debouncedSaveTags();
        });
    }

    onOpen() {
        const { modalEl, contentEl } = this;
        contentEl.empty();

        modalEl.id = 'infobox-edit-modal';

        // Normalize tags data if needed
        if (this.currentData.tags && !Array.isArray(this.currentData.tags)) {
            if (typeof this.currentData.tags === 'string') {
                this.currentData.tags = this.currentData.tags.split(/[\s,]+/).map(t => t.trim().replace(/^#+/, '')).filter(Boolean);
            } else {
                this.currentData.tags = [];
            }
        }

        // Normalize images data to array
        if (!Array.isArray(this.currentData.images) || this.currentData.images.length === 0) {
            if (this.currentData.image) {
                this.currentData.images = [{
                    label: '',
                    image: this.currentData.image || '',
                    caption: this.currentData.caption || ''
                }];
            } else {
                this.currentData.images = [];
            }
        }

        // Basic Details Section
        const basicSection = contentEl.createDiv({ cls: 'infobox-edit-section' });
        const standardFields = ['supertitle', 'title', 'subtitle'];

        standardFields.forEach(key => {
            const row = basicSection.createDiv({ cls: 'infobox-edit-row' });
            const labelText = key.charAt(0).toUpperCase() + key.slice(1);
            row.createEl('label', { text: labelText, cls: 'infobox-edit-label' });

            const inputContainer = row.createDiv({ cls: 'infobox-edit-input-container' });
            const inputEl = inputContainer.createEl('input', {
                type: 'text',
                value: this.currentData[key] || '',
                attr: { 'aria-label': labelText }
            });

            inputEl.addEventListener('input', e => {
                this.currentData[key] = e.target.value;
                this.debouncedSave(key, e.target.value);
            });
        });

        // Tags Section
        const tagsSection = contentEl.createDiv({ cls: 'infobox-edit-section' });
        tagsSection.createEl('h3', {
            text: 'Tags',
            cls: 'infobox-edit-section-header'
        });
        const tagsSectionContainer = tagsSection.createDiv();
        this.renderTagsEditor(tagsSectionContainer);

        // Images Section
        const imageSection = contentEl.createDiv({ cls: 'infobox-edit-section' });
        imageSection.createEl('h3', {
            text: 'Images',
            cls: 'infobox-edit-section-header'
        });
        const imageSectionContainer = imageSection.createDiv();
        this.renderGalleryEditor(imageSectionContainer);

        // Sections & Labels
        const fieldsSection = contentEl.createDiv({ cls: 'infobox-edit-section' });
        fieldsSection.createEl('h3', {
            text: 'Sections & labels',
            cls: 'infobox-edit-section-header'
        });

        this.fieldsContainer = fieldsSection.createDiv({ cls: 'infobox-edit-fields-container' });
        this.renderFieldsEditor();

        const addButtonsRow = fieldsSection.createDiv({ cls: 'infobox-edit-buttons-row' });

        const addSectionBtn = addButtonsRow.createEl('button', {
            text: '+ Add section',
            attr: { 'aria-label': 'Add section', type: 'button' }
        });
        addSectionBtn.addEventListener('click', () => this.addField({ section: 'New section' }));

        const addLabelBtn = addButtonsRow.createEl('button', {
            text: '+ Add label',
            attr: { 'aria-label': 'Add label', type: 'button' }
        });
        addLabelBtn.addEventListener('click', () => this.addField({ 'New label': 'Value' }));
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ImageSuggestModal extends FuzzySuggestModal {
    constructor(app, onChoose) {
        super(app);
        this.onChoose = onChoose;
    }

    getItems() {
        const files = this.app.vault.getFiles();
        const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'];
        return files.filter(file => imageExtensions.includes(file.extension.toLowerCase()));
    }

    getItemText(file) {
        return file.path;
    }

    onChooseItem(file) {
        this.onChoose(file.path);
    }
}

class InfoboxPlugin extends Plugin {
    _pending = null;

    async onload() {
        const r = () => this.scheduleRefresh();
        this.registerEvent(this.app.workspace.on('layout-change', r));
        this.registerEvent(this.app.workspace.on('active-leaf-change', r));
        this.registerEvent(this.app.metadataCache.on('changed', r));
        this.registerEvent(this.app.workspace.on('css-change', r));
        this.app.workspace.onLayoutReady(r);

        this.addCommand({
            id: 'add-infobox',
            name: 'Add infobox',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;

                if (!checking) {
                    const cache = this.app.metadataCache.getFileCache(file);
                    const hasExisting = cache?.frontmatter?.infobox && typeof cache.frontmatter.infobox === 'object';
                    const currentIb = hasExisting
                        ? JSON.parse(JSON.stringify(cache.frontmatter.infobox))
                        : { title: file.basename, fields: [] };

                    // If no infobox exists yet, write the initial structure to frontmatter
                    if (!hasExisting) {
                        this.app.fileManager.processFrontMatter(file, frontmatter => {
                            frontmatter.infobox = JSON.parse(JSON.stringify(currentIb));
                        });
                    }

                    new InfoboxEditModal(this.app, file, currentIb).open();
                }
                return true;
            }
        });

        this.addCommand({
            id: 'remove-infobox',
            name: 'Remove infobox',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;

                const cache = this.app.metadataCache.getFileCache(file);
                const hasInfobox = cache?.frontmatter?.infobox && typeof cache.frontmatter.infobox === 'object';
                if (!hasInfobox) return false;

                if (!checking) {
                    this.app.fileManager.processFrontMatter(file, frontmatter => {
                        delete frontmatter.infobox;
                    });
                }
                return true;
            }
        });
    }

    onunload() {
        if (this._pending != null) cancelAnimationFrame(this._pending);
        document.querySelectorAll('.infobox-panel').forEach(e => e.remove());
        document.querySelectorAll('.has-infobox').forEach(e => e.classList.remove('has-infobox'));
    }

    scheduleRefresh() {
        if (this._pending != null) cancelAnimationFrame(this._pending);
        this._pending = requestAnimationFrame(() => {
            this._pending = null;
            this.refresh();
        });
    }

    refresh() {
        this.app.workspace.iterateAllLeaves(leaf => {
            try { this.processLeaf(leaf); }
            catch (e) { console.error('[Infobox]', e); }
        });
    }

    getThemeClass() {
        return document.body.classList.contains('theme-dark')
            ? 'infobox-theme-dark'
            : 'infobox-theme-light';
    }

    normalizeTags(value) {
        const tags = [];
        const seen = new Set();

        const addTag = raw => {
            if (raw == null) return;

            if (Array.isArray(raw)) {
                raw.forEach(addTag);
                return;
            }

            if (typeof raw === 'object') {
                addTag(raw.tag ?? raw.name ?? '');
                return;
            }

            const parts = String(raw)
                .split(/[\s,]+/)
                .map(tag => tag.trim().replace(/^#+/, '').replace(/,+$/, ''))
                .filter(Boolean);

            for (const tag of parts) {
                const key = tag.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                tags.push(tag);
            }
        };

        addTag(value);
        return tags;
    }

    getTags(ib, fm, cache) {
        if (ib.showTags === false) return [];
        if (ib.tags != null) return this.normalizeTags(ib.tags);

        const sources = [];

        if (fm.tags != null) sources.push(fm.tags);
        if (Array.isArray(cache?.tags)) {
            sources.push(cache.tags.map(tagCache => tagCache.tag));
        }

        return this.normalizeTags(sources);
    }

    getLinkDisplayText(linkText) {
        const target = String(linkText ?? '').trim();
        const withoutSubpath = target.replace(/[#^].*$/, '');
        const pageName = withoutSubpath.split('/').filter(Boolean).pop();
        return pageName || target;
    }

    normalizeInlineValue(value) {
        if (value == null) return '';

        if (Array.isArray(value)) {
            if (
                value.length === 1 &&
                Array.isArray(value[0]) &&
                value[0].length === 1 &&
                value[0][0] != null &&
                typeof value[0][0] !== 'object'
            ) {
                return `[[${String(value[0][0]).trim()}]]`;
            }

            return value.map(item => this.normalizeInlineValue(item)).join(', ');
        }

        return String(value);
    }

    renderInlineTextFallback(parent, text, file) {
        const linkPattern = /!?\[\[([^\]]+)\]\]/g;
        let lastIndex = 0;
        let match;

        while ((match = linkPattern.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            const rawLink = match[1].trim();
            const pipeIndex = rawLink.indexOf('|');
            const target = (pipeIndex >= 0 ? rawLink.slice(0, pipeIndex) : rawLink).trim();
            const display = (pipeIndex >= 0 ? rawLink.slice(pipeIndex + 1) : this.getLinkDisplayText(target)).trim();

            if (target) {
                const link = parent.createEl('a', {
                    cls: 'internal-link infobox-link',
                    text: display || target,
                    attr: {
                        href: target,
                        'data-href': target
                    }
                });
                link.addEventListener('click', event => {
                    event.preventDefault();
                    this.app.workspace.openLinkText(target, file.path);
                });
            } else {
                parent.appendChild(document.createTextNode(match[0]));
            }

            lastIndex = linkPattern.lastIndex;
        }

        if (lastIndex < text.length) {
            parent.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
    }

    renderInlineText(parent, value, file) {
        const text = this.normalizeInlineValue(value);

        if (typeof MarkdownRenderer !== 'undefined' && MarkdownRenderer.renderMarkdown) {
            const temp = createDiv();
            MarkdownRenderer.renderMarkdown(text, temp, file.path, this).then(() => {
                temp.querySelectorAll('a').forEach(a => a.classList.add('infobox-link'));
                if (temp.childNodes.length === 1 && temp.firstChild.nodeName === 'P') {
                    const p = temp.firstChild;
                    while (p.firstChild) {
                        parent.appendChild(p.firstChild);
                    }
                } else {
                    while (temp.firstChild) {
                        parent.appendChild(temp.firstChild);
                    }
                }
            });
            return;
        }

        this.renderInlineTextFallback(parent, text, file);
    }

    createTextDiv(parent, cls, value, file) {
        return this.createTextEl(parent, 'div', cls, value, file);
    }

    createTextEl(parent, tag, cls, value, file) {
        const el = parent.createEl(tag, { cls });
        this.renderInlineText(el, value, file);
        return el;
    }

    renderFieldValue(parent, value, file) {
        const container = parent.createDiv({ cls: 'infobox-value' });
        let items = [];

        if (Array.isArray(value)) {
            items = value;
        } else if (typeof value === 'string') {
            if (value.includes('\n')) {
                items = value.split('\n').map(s => s.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
            } else if (value.includes('|')) {
                const parts = splitOutsideWikilinks(value, '|');
                items = parts.length > 1 ? parts : [value];
            } else if (value.includes(',')) {
                const parts = splitOutsideWikilinks(value, ',');
                items = parts.length > 1 ? parts : [value];
            } else {
                items = [value];
            }
        } else {
            items = [String(value ?? '')];
        }

        if (items.length > 1) {
            const ul = container.createEl('ul', { cls: 'infobox-list' });
            items.forEach(item => {
                const li = ul.createEl('li');
                this.renderInlineText(li, item, file);
            });
        } else {
            this.renderInlineText(container, items[0] || '', file);
        }
    }

    processLeaf(leaf) {
        const view = leaf.view;
        if (!view || view.getViewType() !== 'markdown') return;

        const ct = view.containerEl;
        if (!ct) return;

        // Always clean up first
        ct.querySelectorAll('.infobox-panel').forEach(e => e.remove());
        ct.classList.remove('has-infobox');

        const file = view.file;
        if (!file) return;

        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (!fm?.infobox || typeof fm.infobox !== 'object') return;

        const ib = fm.infobox;
        const tags = this.getTags(ib, fm, cache);

        // ── Build panel ──────────────────────────────────────────
        const panel = createDiv({ cls: 'infobox-panel' });
        const card = panel.createDiv({ cls: 'infobox' });
        const themeClass = this.getThemeClass();
        panel.addClass(themeClass);
        card.addClass(themeClass);

        // Supertitle
        if (ib.supertitle) {
            this.createTextDiv(card, 'infobox-supertitle', ib.supertitle, file);
        }

        // Title
        if (ib.title) {
            this.createTextDiv(card, 'infobox-title', ib.title, file);
        }

        // Subtitle
        if (ib.subtitle) {
            this.createTextDiv(card, 'infobox-subtitle', ib.subtitle, file);
        }

        // Image / image gallery
        const images = Array.isArray(ib.images) && ib.images.length > 0
            ? ib.images.filter(e => e && e.image)
            : ib.image
                ? [{
                    label: '',
                    image: ib.image,
                    caption: ib.caption || ''
                }]
                : [];

        if (images.length > 0) {
            const gallery = card.createDiv({ cls: 'infobox-gallery' });

            let tabs = null;

            if (images.length > 1) {
                tabs = gallery.createDiv({ cls: 'infobox-image-tabs' });
            }

            const wrap = gallery.createDiv({ cls: 'infobox-image' });
            const img = wrap.createEl('img');

            const caption = gallery.createDiv({
                cls: 'infobox-caption infobox-gallery-caption'
            });

            const resolveImage = imageValue => {
                if (!imageValue) return '';

                let src = String(imageValue).trim();

                src = src
                    .replace(/^!?\[\[(.+?)(\|.*)?\]\]$/, '$1')
                    .trim();

                if (src.startsWith('http')) {
                    return src;
                }

                const resolved =
                    this.app.metadataCache.getFirstLinkpathDest(
                        src,
                        file.path
                    );

                return resolved
                    ? this.app.vault.getResourcePath(resolved)
                    : '';
            };

            const showImage = (entry, index) => {
                const src = resolveImage(entry.image);

                if (src) {
                    img.src = src;
                } else {
                    img.removeAttribute('src');
                }

                img.alt = String(
                    entry.caption ||
                    entry.label ||
                    ib.title ||
                    ''
                );

                caption.empty();

                if (entry.caption) {
                    this.renderInlineText(
                        caption,
                        entry.caption,
                        file
                    );
                }
                caption.classList.toggle('is-hidden', !entry.caption);

                if (tabs) {
                    const tabElements =
                        tabs.querySelectorAll('.infobox-image-tab');

                    tabElements.forEach((tab, tabIndex) => {
                        tab.classList.toggle(
                            'is-active',
                            tabIndex === index
                        );
                    });
                }
            };

            if (tabs) {
                images.forEach((entry, index) => {
                    const tab = tabs.createEl('button', {
                        cls: 'infobox-image-tab',
                        text: entry.label || `Image ${index + 1}`,
                        attr: {
                            type: 'button',
                            'aria-label': entry.label || `Image ${index + 1}`
                        }
                    });

                    tab.addEventListener('click', event => {
                        event.preventDefault();
                        event.stopPropagation();

                        showImage(entry, index);
                    });
                });
            }

            showImage(images[0], 0);
        }

        // Tags
        if (tags.length > 0) {
            const tagList = card.createDiv({ cls: 'infobox-tags' });
            for (const tag of tags) {
                const displayTag = `#${tag}`;
                const tagEl = tagList.createEl('a', {
                    cls: 'infobox-tag tag',
                    text: displayTag,
                    attr: { href: displayTag }
                });
                tagEl.setAttr('data-tag', tag);
                tagEl.addEventListener('click', event => {
                    event.preventDefault();
                    this.app.workspace.openLinkText(displayTag, file.path);
                });
            }
        }

        // Fields (array of single-key objects)
        if (Array.isArray(ib.fields)) {
            for (const item of ib.fields) {
                if (!item || typeof item !== 'object') continue;
                const key = Object.keys(item)[0];
                if (!key) continue;
                const val = item[key];

                if (key.toLowerCase() === 'section') {
                    this.createTextDiv(card, 'infobox-section', val, file);
                } else {
                    const row = card.createDiv({ cls: 'infobox-row' });
                    this.createTextEl(row, 'span', 'infobox-label', key, file);
                    this.renderFieldValue(row, val, file);
                }
            }
        }

        // Edit button
        const editBtn = panel.createEl('button', {
            text: 'Edit',
            cls: 'infobox-edit-button',
            attr: {
                'aria-label': 'Edit infobox',
                type: 'button'
            }
        });
        editBtn.addEventListener('click', () => {
            new InfoboxEditModal(this.app, file, JSON.parse(JSON.stringify(ib))).open();
        });

        ct.appendChild(panel);
        ct.classList.add('has-infobox');
    }
}

module.exports = InfoboxPlugin;
