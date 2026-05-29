// Icon resolver: maps a filename / extension to a colored SVG, similar to
// the Material / Seti icon themes. Pure data + a tiny renderer — no deps.
//
// Strategy:
//  1) special-case filenames (package.json, Dockerfile, tsconfig.json, ...)
//  2) special-case extensions for the most common languages with bespoke SVGs
//  3) fallback to a generic "page with badge" icon, using a short label
//     derived from the extension. The badge colour is derived from a curated
//     extension→colour map, or a stable hash for unknown extensions.

(function () {
    // -- colour palette (tuned to feel familiar across dark/light themes) -----
    const C = {
        js:        '#F1DD35',
        ts:        '#3178C6',
        json:      '#FCBA03',
        md:        '#42A5F5',
        html:      '#E44D26',
        css:       '#1572B6',
        scss:      '#CD6799',
        less:      '#2A4D80',
        vue:       '#41B883',
        svelte:    '#FF3E00',
        astro:     '#FF5D01',
        py:        '#3572A5',
        rs:        '#DEA584',
        go:        '#00ADD8',
        java:      '#B07219',
        c:         '#555555',
        cpp:       '#F34B7D',
        cs:        '#178600',
        rb:        '#CC342D',
        php:       '#777BB4',
        swift:     '#FA7343',
        kt:        '#A97BFF',
        scala:     '#C22D40',
        dart:      '#00B4AB',
        lua:       '#000080',
        sh:        '#89E051',
        ps1:       '#012456',
        yaml:      '#CB171E',
        toml:      '#9C4221',
        xml:       '#E37933',
        env:       '#FAD03F',
        ini:       '#6D8086',
        sql:       '#E38C00',
        txt:       '#888888',
        rst:       '#3B7EBF',
        log:       '#6F6F6F',
        lock:      '#A0A0A0',
        zip:       '#B58900',
        font:      '#C792EA',
        image:     '#26A69A',
        video:     '#EC407A',
        audio:     '#7E57C2',
        bin:       '#607D8B',
        config:    '#90A4AE',
        test:      '#FFB300',
        docker:    '#0DB7ED',
        git:       '#F14E32',
        node:      '#83CD29',
        npm:       '#CB3837',
        eslint:    '#4B32C3',
        prettier:  '#F7B93E',
        babel:     '#F5DA55',
        editor:    '#FFD600',
        readme:    '#2196F3',
        license:   '#D32F2F',
        changelog: '#26A69A',
        rs_default:'#519ABA',
    };

    // -- by full filename (case-insensitive) ----------------------------------
    const byName = {
        'package.json':       { color: C.npm,       label: 'npm' },
        'package-lock.json':  { color: C.npm,       label: 'npm' },
        'yarn.lock':          { color: C.npm,       label: 'yarn' },
        'pnpm-lock.yaml':     { color: C.npm,       label: 'pnpm' },
        'bun.lockb':          { color: C.npm,       label: 'bun' },
        'tsconfig.json':      { color: C.ts,        label: 'tsc' },
        'jsconfig.json':      { color: C.js,        label: 'jsc' },
        'dockerfile':         { color: C.docker,    label: 'dck' },
        'docker-compose.yml': { color: C.docker,    label: 'dck' },
        'docker-compose.yaml':{ color: C.docker,    label: 'dck' },
        '.dockerignore':      { color: C.docker,    label: 'dck' },
        '.gitignore':         { color: C.git,       label: 'git' },
        '.gitattributes':     { color: C.git,       label: 'git' },
        '.gitmodules':        { color: C.git,       label: 'git' },
        '.npmrc':             { color: C.npm,       label: 'npm' },
        '.npmignore':         { color: C.npm,       label: 'npm' },
        '.nvmrc':             { color: C.node,      label: 'nvm' },
        '.editorconfig':      { color: C.editor,    label: 'ed' },
        '.eslintrc':          { color: C.eslint,    label: 'es' },
        '.eslintrc.js':       { color: C.eslint,    label: 'es' },
        '.eslintrc.cjs':      { color: C.eslint,    label: 'es' },
        '.eslintrc.json':     { color: C.eslint,    label: 'es' },
        '.eslintrc.yml':      { color: C.eslint,    label: 'es' },
        'eslint.config.js':   { color: C.eslint,    label: 'es' },
        'eslint.config.mjs':  { color: C.eslint,    label: 'es' },
        '.prettierrc':        { color: C.prettier,  label: 'pr' },
        '.prettierrc.json':   { color: C.prettier,  label: 'pr' },
        '.prettierrc.js':     { color: C.prettier,  label: 'pr' },
        '.babelrc':           { color: C.babel,     label: 'ba' },
        'babel.config.js':    { color: C.babel,     label: 'ba' },
        'makefile':           { color: '#A4470F',   label: 'mk' },
        'cmakelists.txt':     { color: '#7C3AED',   label: 'cm' },
        'license':            { color: C.license,   label: 'lic' },
        'license.md':         { color: C.license,   label: 'lic' },
        'license.txt':        { color: C.license,   label: 'lic' },
        'readme.md':          { color: C.readme,    label: 'rdm' },
        'readme':             { color: C.readme,    label: 'rdm' },
        'changelog.md':       { color: C.changelog, label: 'log' },
        '.env':               { color: C.env,       label: 'env' },
        '.env.local':         { color: C.env,       label: 'env' },
        '.env.development':   { color: C.env,       label: 'env' },
        '.env.production':    { color: C.env,       label: 'env' },
        '.env.test':          { color: C.env,       label: 'env' },
    };

    // -- by extension ---------------------------------------------------------
    const byExt = {
        // js family
        js:        { color: C.js,      label: 'js' },
        mjs:       { color: C.js,      label: 'mjs' },
        cjs:       { color: C.js,      label: 'cjs' },
        jsx:       { color: C.js,      label: 'jsx' },
        // ts family
        ts:        { color: C.ts,      label: 'ts' },
        tsx:       { color: C.ts,      label: 'tsx' },
        mts:       { color: C.ts,      label: 'mts' },
        cts:       { color: C.ts,      label: 'cts' },
        d:         { color: C.ts,      label: 'd' },     // *.d.ts handled specially
        // languages
        py:        { color: C.py,      label: 'py' },
        pyi:       { color: C.py,      label: 'pyi' },
        rb:        { color: C.rb,      label: 'rb' },
        php:       { color: C.php,     label: 'php' },
        java:      { color: C.java,    label: 'jv' },
        kt:        { color: C.kt,      label: 'kt' },
        kts:       { color: C.kt,      label: 'kt' },
        scala:     { color: C.scala,   label: 'sc' },
        rs:        { color: C.rs,      label: 'rs' },
        go:        { color: C.go,      label: 'go' },
        c:         { color: C.c,       label: 'c' },
        h:         { color: C.c,       label: 'h' },
        cpp:       { color: C.cpp,     label: 'cpp' },
        cc:        { color: C.cpp,     label: 'cc' },
        cxx:       { color: C.cpp,     label: 'cxx' },
        hpp:       { color: C.cpp,     label: 'hpp' },
        cs:        { color: C.cs,      label: 'cs' },
        swift:     { color: C.swift,   label: 'sw' },
        m:         { color: C.swift,   label: 'm' },
        dart:      { color: C.dart,    label: 'dt' },
        lua:       { color: C.lua,     label: 'lua' },
        r:         { color: '#198CE7', label: 'R' },
        pl:        { color: '#0298C3', label: 'pl' },
        ex:        { color: '#6E4A7E', label: 'ex' },
        exs:       { color: '#6E4A7E', label: 'ex' },
        elm:       { color: '#60B5CC', label: 'el' },
        clj:       { color: '#DB5855', label: 'clj' },
        // shells
        sh:        { color: C.sh,      label: 'sh' },
        bash:      { color: C.sh,      label: 'sh' },
        zsh:       { color: C.sh,      label: 'sh' },
        fish:      { color: C.sh,      label: 'sh' },
        ps1:       { color: C.ps1,     label: 'ps' },
        bat:       { color: '#C1F12E', label: 'bat' },
        cmd:       { color: '#C1F12E', label: 'cmd' },
        // web
        html:      { color: C.html,    label: 'html' },
        htm:       { color: C.html,    label: 'htm' },
        xhtml:     { color: C.html,    label: 'xht' },
        ejs:       { color: '#A91E50', label: 'ejs' },
        hbs:       { color: '#F0A04C', label: 'hb' },
        pug:       { color: '#A86454', label: 'pug' },
        css:       { color: C.css,     label: 'css' },
        scss:      { color: C.scss,    label: 'scs' },
        sass:      { color: C.scss,    label: 'sas' },
        less:      { color: C.less,    label: 'les' },
        styl:      { color: '#FF6347', label: 'sty' },
        vue:       { color: C.vue,     label: 'vue' },
        svelte:    { color: C.svelte,  label: 'svl' },
        astro:     { color: C.astro,   label: 'ast' },
        // data / config
        json:      { color: C.json,    label: 'jsn' },
        json5:     { color: C.json,    label: 'js5' },
        jsonc:     { color: C.json,    label: 'jsc' },
        yaml:      { color: C.yaml,    label: 'yml' },
        yml:       { color: C.yaml,    label: 'yml' },
        toml:      { color: C.toml,    label: 'tml' },
        xml:       { color: C.xml,     label: 'xml' },
        ini:       { color: C.ini,     label: 'ini' },
        conf:      { color: C.config,  label: 'cfg' },
        cfg:       { color: C.config,  label: 'cfg' },
        properties:{ color: C.config,  label: 'prp' },
        env:       { color: C.env,     label: 'env' },
        // docs
        md:        { color: C.md,      label: 'md' },
        mdx:       { color: C.md,      label: 'mdx' },
        rst:       { color: C.rst,     label: 'rst' },
        txt:       { color: C.txt,     label: 'txt' },
        rtf:       { color: C.txt,     label: 'rtf' },
        // databases
        sql:       { color: C.sql,     label: 'sql' },
        db:        { color: C.bin,     label: 'db' },
        sqlite:    { color: C.bin,     label: 'sql' },
        sqlite3:   { color: C.bin,     label: 'sql' },
        // logs
        log:       { color: C.log,     label: 'log' },
        // images
        png:       { color: C.image,   label: 'png' },
        jpg:       { color: C.image,   label: 'jpg' },
        jpeg:      { color: C.image,   label: 'jpg' },
        gif:       { color: C.image,   label: 'gif' },
        bmp:       { color: C.image,   label: 'bmp' },
        webp:      { color: C.image,   label: 'wbp' },
        avif:      { color: C.image,   label: 'avi' },
        ico:       { color: C.image,   label: 'ico' },
        svg:       { color: '#FFB300', label: 'svg' },
        // video
        mp4:       { color: C.video,   label: 'mp4' },
        mov:       { color: C.video,   label: 'mov' },
        mkv:       { color: C.video,   label: 'mkv' },
        avi:       { color: C.video,   label: 'avi' },
        webm:      { color: C.video,   label: 'wbm' },
        // audio
        mp3:       { color: C.audio,   label: 'mp3' },
        wav:       { color: C.audio,   label: 'wav' },
        ogg:       { color: C.audio,   label: 'ogg' },
        flac:      { color: C.audio,   label: 'flc' },
        // archives
        zip:       { color: C.zip,     label: 'zip' },
        tar:       { color: C.zip,     label: 'tar' },
        gz:        { color: C.zip,     label: 'gz' },
        tgz:       { color: C.zip,     label: 'tgz' },
        rar:       { color: C.zip,     label: 'rar' },
        '7z':      { color: C.zip,     label: '7z' },
        bz2:       { color: C.zip,     label: 'bz2' },
        // binaries
        exe:       { color: C.bin,     label: 'exe' },
        dll:       { color: C.bin,     label: 'dll' },
        so:        { color: C.bin,     label: 'so' },
        dylib:     { color: C.bin,     label: 'dyl' },
        app:       { color: C.bin,     label: 'app' },
        dmg:       { color: C.bin,     label: 'dmg' },
        bin:       { color: C.bin,     label: 'bin' },
        wasm:      { color: '#654FF0', label: 'wsm' },
        // fonts
        ttf:       { color: C.font,    label: 'ttf' },
        otf:       { color: C.font,    label: 'otf' },
        woff:      { color: C.font,    label: 'wof' },
        woff2:     { color: C.font,    label: 'wf2' },
        eot:       { color: C.font,    label: 'eot' },
        // pdf
        pdf:       { color: '#E94335', label: 'pdf' },
        // tests
        snap:      { color: C.test,    label: 'snp' },
        // misc
        vsix:      { color: '#0078D7', label: 'vsx' },
        ipynb:     { color: '#F37726', label: 'ipy' },
        graphql:   { color: '#E10098', label: 'gql' },
        gql:       { color: '#E10098', label: 'gql' },
        proto:     { color: '#FB7E14', label: 'prt' },
    };

    function escapeXml(s) {
        return String(s).replace(/[<>&"']/g, c => ({
            '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
        }[c]));
    }

    // Stable colour fallback for unknown extensions: hash extension → hue.
    function hashColor(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        const hue = Math.abs(h) % 360;
        return `hsl(${hue}, 55%, 55%)`;
    }

    function resolveSpec(name) {
        const lower = name.toLowerCase();
        if (byName[lower]) return { ...byName[lower], known: true };

        // ".d.ts" compound
        if (lower.endsWith('.d.ts')) return { color: C.ts, label: 'd.ts', known: true };
        if (lower.endsWith('.test.ts') || lower.endsWith('.spec.ts')) return { color: C.test, label: 'tst', known: true };
        if (lower.endsWith('.test.js') || lower.endsWith('.spec.js')) return { color: C.test, label: 'tst', known: true };

        const dot = lower.lastIndexOf('.');
        if (dot <= 0 || dot === lower.length - 1) {
            // no extension — generic
            return { color: C.txt, label: lower.slice(0, 3) || '?', known: false };
        }
        const ext = lower.slice(dot + 1);
        if (byExt[ext]) return { ...byExt[ext], known: true };
        return { color: hashColor(ext), label: ext.slice(0, 3), known: false };
    }

    /**
     * Build an SVG string for a file icon.
     * Style: a folded-corner page silhouette in the type colour with a small
     * coloured badge containing 1-3 letters identifying the type.
     */
    function buildFileSvg(name) {
        const spec = resolveSpec(name);
        const color = spec.color;
        const labelRaw = spec.label || '?';
        // shrink labels to fit
        const label = labelRaw.length > 3 ? labelRaw.slice(0, 3) : labelRaw;
        // text size scales with length: 1→7, 2→6, 3→4.5
        const fontSize = label.length >= 3 ? 4.4 : label.length === 2 ? 5.6 : 7;
        const safeLabel = escapeXml(label.toUpperCase());

        // Single-letter labels render as a centred glyph; multi-letter as bottom badge.
        if (label.length === 1) {
            return `
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M9.5 1.5H3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5.5L9.5 1.5z"
          fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="1"/>
    <path d="M9.5 1.5V5.5h4" fill="none" stroke="${color}" stroke-width="1"/>
    <text x="8" y="11.2" text-anchor="middle" font-family="var(--vscode-font-family,sans-serif)"
          font-size="6.6" font-weight="700" fill="${color}">${safeLabel}</text>
</svg>`;
        }

        return `
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M9.5 1.5H3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5.5L9.5 1.5z"
          fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="1"/>
    <path d="M9.5 1.5V5.5h4" fill="none" stroke="${color}" stroke-width="1"/>
    <rect x="2.5" y="9.5" width="${label.length >= 3 ? 11 : 9}" height="4.2" rx="0.8" fill="${color}"/>
    <text x="${label.length >= 3 ? 8 : 7}" y="${label.length >= 3 ? 12.6 : 12.7}"
          text-anchor="middle"
          font-family="var(--vscode-font-family,sans-serif)" font-size="${fontSize}"
          font-weight="700" fill="#fff">${safeLabel}</text>
</svg>`;
    }

    function buildFolderSvg(isExpanded, name) {
        // Special folders get a tinted folder.
        const lower = (name || '').toLowerCase();
        let tint = null;
        if (lower === '.git') tint = C.git;
        else if (lower === 'node_modules') tint = C.node;
        else if (lower === '.vscode') tint = '#23A9F2';
        else if (lower === 'src' || lower === 'source' || lower === 'sources') tint = '#519ABA';
        else if (lower === 'test' || lower === 'tests' || lower === '__tests__') tint = C.test;
        else if (lower === 'docs' || lower === 'doc' || lower === 'documentation') tint = C.md;
        else if (lower === 'media' || lower === 'assets' || lower === 'public' || lower === 'static') tint = C.image;
        else if (lower === 'dist' || lower === 'build' || lower === 'out') tint = C.bin;

        const color = tint || 'var(--vscode-symbolIcon-folderForeground, #DCB67A)';
        if (isExpanded) {
            return `
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M1.5 4.5l1-1h3.5l1 1h7.5l.5.5v8l-.5.5h-12l-.5-.5v-8l-.5-.5z"
          fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>
    <path d="M2 6h12l-.5 7-12.5-.5L2 6z" fill="${color}" fill-opacity="0.6"/>
</svg>`;
        }
        return `
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M1.5 3.5h4l1.5 1.5h7l1 1v8l-.5.5h-13l-.5-.5v-10l.5-.5z"
          fill="${color}" fill-opacity="0.7" stroke="${color}" stroke-width="0.6" stroke-linejoin="round"/>
</svg>`;
    }

    function getNodeIconSvg(name, isDirectory, isExpanded) {
        if (isDirectory) return buildFolderSvg(!!isExpanded, name);
        return buildFileSvg(name);
    }

    // export
    window.RepoIcons = { getNodeIconSvg, resolveSpec };
})();
