'use strict';

// The files a self-hoster installs from, read as text: docker-compose.yml and
// its .env example, server/.env.example, and the two Unraid templates. Nothing
// here runs Docker or Unraid. Each test pins one way these files have shipped
// a stack that loads and never connects, or a setting that could not take
// effect, and each of those passed every other check in the repository: the
// server's own tests never read these files, and `docker compose config`
// accepts a default that points at the wrong port.
//
// It lives in server/ because these files are how the server's settings reach
// it, and because `npm test` here is the suite every change to them runs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const COMPOSE = read('docker-compose.yml');
const DOCKER_ENV_EXAMPLE = read('.env.docker.example');
const SERVER_ENV_EXAMPLE = read('server/.env.example');
const UNRAID_SERVER = read('unraid/floe-server.xml');
const UNRAID_CLIENT = read('unraid/floe-client.xml');

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

// One service's `environment:` map and `ports:` list, as written. Enough YAML
// for this file and no more: two-space indents, one `KEY: value` per line.
function composeService(name) {
    const lines = COMPOSE.split('\n');
    const start = lines.indexOf(`  ${name}:`);
    assert.notEqual(start, -1, `service ${name} not found in docker-compose.yml`);
    const environment = new Map();
    const ports = [];
    let section = null;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^ {2}\S/.test(line)) break; // the next service
        if (/^\s*(#|$)/.test(line)) continue;
        const key = /^ {4}([a-z_]+):/.exec(line);
        if (key) { section = key[1]; continue; }
        if (section === 'environment') {
            const entry = /^ {6}([A-Z_][A-Z0-9_]*):\s*(.*)$/.exec(line);
            if (entry) environment.set(entry[1], entry[2]);
        } else if (section === 'ports') {
            const entry = /^ {6}-\s*"?([^"]*)"?\s*$/.exec(line);
            if (entry) ports.push(entry[1]);
        }
    }
    return { environment, ports };
}

// Compose's variable interpolation, for the forms this file uses: ${VAR},
// ${VAR:-default} (the default also when VAR is empty), ${VAR-default} (the
// default only when VAR is unset) and ${VAR+word} (word only when VAR is set),
// where a default may hold another variable. `docker compose config` printed
// these same values for the settings the tests below use, on sixteen releases
// from 2.8.0 to 2.39.1 (2026-10-14).
function interpolate(text, env) {
    let out = '';
    let i = 0;
    while (i < text.length) {
        if (text[i] !== '$' || text[i + 1] !== '{') { out += text[i++]; continue; }
        let depth = 1;
        let j = i + 2;
        for (; j < text.length && depth > 0; j++) {
            if (text[j] === '{' && text[j - 1] === '$') depth++;
            else if (text[j] === '}') depth--;
        }
        assert.equal(depth, 0, `unclosed \${ in ${JSON.stringify(text)}`);
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-|:\+|\+)([\s\S]*))?$/.exec(text.slice(i + 2, j - 1));
        assert.ok(m, `not a form this reader knows: ${text.slice(i, j)}`);
        const [, name, op, word] = m;
        const isSet = Object.prototype.hasOwnProperty.call(env, name);
        const nonEmpty = isSet && env[name] !== '';
        if (op === '+' || op === ':+') out += (op === '+' ? isSet : nonEmpty) ? interpolate(word, env) : '';
        else if (op === ':-') out += nonEmpty ? env[name] : interpolate(word, env);
        else if (op === '-') out += isSet ? env[name] : interpolate(word, env);
        else out += isSet ? env[name] : '';
        i = j;
    }
    return out;
}

// `KEY=value` lines of an env example, with whether each is commented out.
function envExample(text) {
    const keys = new Map();
    for (const line of text.split('\n')) {
        const m = /^(#\s*)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
        if (m && !keys.has(m[2])) keys.set(m[2], { commented: Boolean(m[1]), value: m[3] });
    }
    return keys;
}

const XML_ENTITIES = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&apos;': "'" };
const decodeXml = (text) => text.replace(/&(?:quot|amp|lt|gt|apos);/g, (e) => XML_ENTITIES[e]);

// Every <Config> of an Unraid template: its attributes, and `value`, the text
// between the tags, which is what the field holds on a first install.
function unraidConfigs(xml) {
    const configs = [];
    for (const m of xml.matchAll(/<Config\b([^>]*?)(?:\/>|>([^<]*)<\/Config>)/g)) {
        const attrs = {};
        for (const a of m[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)) attrs[a[1]] = decodeXml(a[2]);
        configs.push({ ...attrs, value: decodeXml(m[2] || '') });
    }
    return configs;
}

const byTarget = (configs, target) => configs.find((c) => c.Target === target);

// The TURN_ settings server/turn.js reads, from its source, so a setting added
// there is held to every surface below without this file being edited.
const TURN_SETTINGS = [...new Set(
    [...fs.readFileSync(path.join(__dirname, 'turn.js'), 'utf8').matchAll(/process\.env\.(TURN_[A-Z0-9_]+)/g)]
        .map((m) => m[1])
)];

// ---------------------------------------------------------------------------
// docker-compose.yml
// ---------------------------------------------------------------------------

describe('docker-compose.yml', () => {
    const server = composeService('server');
    const client = composeService('client');

    it('the origin the server allows by default follows CLIENT_PORT', () => {
        // The server accepts a browser from CLIENT_URL and from nowhere else on
        // another port, so a default that stayed on 3000 while the web app was
        // published on 8080 gave a page that loaded and never connected.
        const clientUrl = server.environment.get('CLIENT_URL');
        const rows = [
            [{}, 'http://localhost:3000'],
            [{ CLIENT_PORT: '8080' }, 'http://localhost:8080'],
            [{ CLIENT_PORT: '' }, 'http://localhost:3000'],
            [{ CLIENT_PORT: '8080', CLIENT_URL: 'https://floe.example.com' }, 'https://floe.example.com'],
            [{ CLIENT_PORT: '8080', CLIENT_URL: '' }, 'http://localhost:8080'],
            // The server's own port is no part of it.
            [{ PORT: '4001' }, 'http://localhost:3000'],
        ];
        for (const [env, expected] of rows) {
            assert.equal(interpolate(clientUrl, env), expected, JSON.stringify(env));
        }
    });

    it('the address browsers are given by default follows PORT, and an empty one stays empty', () => {
        const socketUrl = client.environment.get('SOCKET_URL');
        const rows = [
            [{}, 'http://localhost:3001'],
            [{ PORT: '4001' }, 'http://localhost:4001'],
            [{ PORT: '' }, 'http://localhost:3001'],
            [{ PORT: '4001', NEXT_PUBLIC_SOCKET_URL: 'https://api.example.com' }, 'https://api.example.com'],
            // The one-domain layout: set and empty, so the browser uses the
            // origin it loaded from. A default here would send it to localhost.
            [{ NEXT_PUBLIC_SOCKET_URL: '' }, ''],
            [{ PORT: '4001', NEXT_PUBLIC_SOCKET_URL: '' }, ''],
            [{ CLIENT_PORT: '8080' }, 'http://localhost:3001'],
        ];
        for (const [env, expected] of rows) {
            assert.equal(interpolate(socketUrl, env), expected, JSON.stringify(env));
        }
    });

    it('each of those defaults is built from the line that publishes the port', () => {
        // Under every setting of the two port variables, the port in the
        // default address is the host port Compose publishes.
        const hostPort = (service, env) => interpolate(service.ports[0], env).split(':')[0];
        for (const env of [{}, { PORT: '4001' }, { CLIENT_PORT: '8080' }, { PORT: '4001', CLIENT_PORT: '8080' }]) {
            assert.equal(
                interpolate(server.environment.get('CLIENT_URL'), env),
                `http://localhost:${hostPort(client, env)}`,
                JSON.stringify(env)
            );
            assert.equal(
                interpolate(client.environment.get('SOCKET_URL'), env),
                `http://localhost:${hostPort(server, env)}`,
                JSON.stringify(env)
            );
        }
    });

    it('stops a Compose too old to read those defaults, at the client address', () => {
        // Measured on the release binaries, 2026-10-14. Without the check,
        // Compose 2.2.0, 2.2.3, 2.3.0, 2.6.1 and 2.7.0 read the default in front
        // of it as "3001}" whatever NEXT_PUBLIC_SOCKET_URL held, and
        // docker-compose 1.29.2 read both defaults as literal text and left a
        // "}" after a value that was set: every one started a stack whose page
        // loads and never connects, with nothing said. None of them can read
        // ${VAR+word} either, so with it they refuse the file ("invalid
        // interpolation format", quoting this value, name included), and 2.8.0
        // and later read it as nothing.
        const socketUrl = client.environment.get('SOCKET_URL');
        const check = /\$\{([A-Z0-9_]+)\+\}$/.exec(socketUrl);
        assert.ok(check, `SOCKET_URL no longer ends with the version check: ${socketUrl}`);
        // The name is the only explanation an old Compose prints.
        assert.match(check[1], /DOCKER_COMPOSE_2_8/);
        assert.match(COMPOSE, /^# Needs Docker Compose 2\.8\.0 or later/m);
        // Empty whether or not anything by that name is set.
        const bare = socketUrl.slice(0, check.index);
        for (const env of [{}, { [check[1]]: '' }, { [check[1]]: '1' }, { PORT: '4001' }, { NEXT_PUBLIC_SOCKET_URL: '' }]) {
            assert.equal(interpolate(socketUrl, env), interpolate(bare, env), JSON.stringify(env));
        }
    });

    it('passes every TURN_ setting the server reads into the server container', () => {
        // A variable missing from the environment block never reaches the
        // container, whatever the .env file says, and nothing reports it.
        assert.ok(TURN_SETTINGS.includes('TURN_SECRET') && TURN_SETTINGS.includes('TURN_DOMAIN'), TURN_SETTINGS.join(', '));
        for (const name of TURN_SETTINGS) {
            assert.ok(server.environment.has(name), `${name} is not in the server's environment block`);
            assert.equal(interpolate(server.environment.get(name), { [name]: 'typed' }), 'typed', name);
            assert.equal(interpolate(server.environment.get(name), {}), '', `${name} should be empty unless set`);
        }
    });

    it('the policy folder example mounts read-only at the folder the Unraid template uses', () => {
        const mount = /^\s*#\s*-\s*\.\/policy:(\/[^:\s]+):ro\s*$/m.exec(COMPOSE);
        assert.ok(mount, 'the commented volumes example for the policy folder is gone');
        const folder = unraidConfigs(UNRAID_SERVER).find((c) => c.Type === 'Path');
        assert.ok(folder, 'the Unraid server template has no Path');
        assert.equal(folder.Target, mount[1]);
    });
});

// ---------------------------------------------------------------------------
// The two env examples
// ---------------------------------------------------------------------------

describe('.env.docker.example', () => {
    const keys = envExample(DOCKER_ENV_EXAMPLE);

    it('leaves the two addresses that follow the ports for Compose to work out', () => {
        // A value set here wins over the default in docker-compose.yml, so a
        // copy of this file that pinned both to localhost:3000 and :3001 put
        // the mismatch straight back the moment a port below it was changed.
        for (const name of ['CLIENT_URL', 'NEXT_PUBLIC_SOCKET_URL']) {
            assert.ok(keys.has(name), `${name} is no longer described`);
            assert.equal(keys.get(name).commented, true, `${name} is set, so it no longer follows its port`);
        }
        for (const name of ['PORT', 'CLIENT_PORT']) assert.ok(keys.has(name), `${name} is no longer described`);
    });

    it('lists every TURN_ setting the server reads', () => {
        for (const name of TURN_SETTINGS) assert.ok(keys.has(name), `${name} is missing`);
    });
});

describe('server/.env.example', () => {
    it('lists every TURN_ setting the server reads', () => {
        const keys = envExample(SERVER_ENV_EXAMPLE);
        for (const name of TURN_SETTINGS) assert.ok(keys.has(name), `${name} is missing`);
    });
});

// ---------------------------------------------------------------------------
// Unraid templates
// ---------------------------------------------------------------------------

describe('Unraid templates', () => {
    const serverConfigs = unraidConfigs(UNRAID_SERVER);
    const clientConfigs = unraidConfigs(UNRAID_CLIENT);
    const all = [
        ...serverConfigs.map((c) => ['floe-server.xml', c]),
        ...clientConfigs.map((c) => ['floe-client.xml', c]),
    ];

    it('every field is one Unraid can read', () => {
        assert.ok(serverConfigs.length >= 10 && clientConfigs.length >= 2, 'the reader found too few fields');
        const count = (xml) => (xml.match(/<Config\b/g) || []).length;
        assert.equal(serverConfigs.length, count(UNRAID_SERVER), 'a field in floe-server.xml was not read');
        assert.equal(clientConfigs.length, count(UNRAID_CLIENT), 'a field in floe-client.xml was not read');
        // The Mode values are the ones Unraid's own reader keeps (Helpers.php,
        // xmlToVar); it turns any other Path mode into rw without a word.
        const modes = {
            Port: ['tcp', 'udp'],
            Path: ['rw', 'rw,slave', 'rw,shared', 'ro', 'ro,slave', 'ro,shared'],
        };
        for (const [file, c] of all) {
            const where = `${file}: ${c.Name}`;
            for (const attr of ['Name', 'Target', 'Default', 'Description', 'Type', 'Display', 'Required', 'Mask']) {
                assert.equal(typeof c[attr], 'string', `${where} has no ${attr}`);
            }
            assert.ok(['Port', 'Variable', 'Path'].includes(c.Type), `${where}: Type ${c.Type}`);
            assert.ok(['always', 'advanced'].includes(c.Display), `${where}: Display ${c.Display}`);
            assert.ok(['true', 'false'].includes(c.Required), `${where}: Required ${c.Required}`);
            assert.ok(['true', 'false'].includes(c.Mask), `${where}: Mask ${c.Mask}`);
            if (modes[c.Type]) assert.ok(modes[c.Type].includes(c.Mode), `${where}: Mode ${c.Mode}`);
            else assert.equal(c.Mode, undefined, `${where}: a Variable takes no Mode`);
            assert.ok(c.Name && c.Target && c.Description, `${where}: an empty Name, Target or Description`);
        }
    });

    it('every field ships holding its Default, so clearing a field clears it', () => {
        // Unraid uses the Default whenever the field itself is empty, on a
        // first install and again each time the container is edited
        // (Helpers.php: strlen(value) ? value : Default). A field whose Default
        // is not empty can therefore never be emptied from the form, which is
        // what the one-domain layout needs of Signaling Server URL.
        for (const [file, c] of all) {
            assert.equal(c.value, c.Default, `${file}: ${c.Name} ships ${JSON.stringify(c.value)} beside Default ${JSON.stringify(c.Default)}`);
        }
        // Only a field with one right answer for every install may carry a
        // Default at all: the two container ports, the direct-access proxy
        // count and the connection limit.
        const withDefault = all.filter(([, c]) => c.Default !== '').map(([, c]) => c.Target).sort();
        assert.deepEqual(withDefault, ['3000', '3001', 'MAX_CONNECTIONS_PER_IP', 'TRUSTED_PROXY_COUNT']);
    });

    it('the client template ships Signaling Server URL empty and says what to put there', () => {
        const field = byTarget(clientConfigs, 'SOCKET_URL');
        assert.ok(field, 'no SOCKET_URL field');
        assert.equal(field.value, '');
        assert.equal(field.Default, '');
        // Empty is right behind one domain and wrong on direct LAN ports, so
        // the field cannot be Required; the description carries the rest.
        assert.equal(field.Required, 'false');
        assert.equal(field.Display, 'always');
        assert.match(field.Description, /http:\/\/192\.168\.1\.10:3001/);
        assert.match(field.Description, /empty/i);
        // No address in either file is a stand-in an install could run with.
        for (const xml of [UNRAID_SERVER, UNRAID_CLIENT]) assert.doesNotMatch(xml, /YOUR-/);
    });

    it('the server template maps a read-only folder for the policy file, empty until it is filled in', () => {
        const file = byTarget(serverConfigs, 'POLICY_FILE');
        assert.ok(file, 'no POLICY_FILE field');
        const paths = serverConfigs.filter((c) => c.Type === 'Path');
        assert.equal(paths.length, 1, 'expected one Path: the policy folder');
        const [folder] = paths;
        // A folder, not the file: an edit renames a new file over the old one,
        // and a single-file mount keeps showing the old one.
        assert.match(folder.Target, /^\/app\/[a-z]+$/);
        assert.equal(folder.Mode, 'ro');
        // Empty, so an install that never turns request links on gets no
        // mount, no folder on the array and no "policy file not found" line.
        // Unraid skips a Path whose host side is empty.
        assert.equal(folder.value, '');
        assert.equal(file.value, '');
        assert.equal(folder.Required, 'false');
        assert.equal(folder.Display, file.Display);
        // Each field points at the other, by the path that joins them.
        assert.ok(file.Description.includes(`${folder.Target}/policy.json`), file.Description);
        assert.ok(folder.Description.includes(folder.Target), folder.Description);
        assert.ok(file.Description.includes(folder.Name), file.Description);
        assert.ok(serverConfigs.indexOf(folder) < serverConfigs.indexOf(file), 'the folder comes before the file that lives in it');
    });

    it('the server template offers every TURN_ setting the server reads', () => {
        for (const name of TURN_SETTINGS) {
            const field = byTarget(serverConfigs, name);
            assert.ok(field, `${name} has no field`);
            assert.equal(field.Type, 'Variable');
            assert.equal(field.value, '', `${name} ships a value`);
        }
        assert.equal(byTarget(serverConfigs, 'TURN_SECRET').Mask, 'true');
    });
});
