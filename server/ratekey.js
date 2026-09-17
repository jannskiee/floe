// The key every per-IP limiter counts under. A module of its own because
// server.js requires turn.js and stats.js, which both need it, so it cannot
// live in server.js.
//
// IPv6 hosts pick addresses freely inside their /64 (privacy addresses rotate
// on their own), so one host could step past every limit by changing the low
// 64 bits; the /64 is the smallest unit a client cannot rotate out of. A
// dual-stack listener reports IPv4 clients as IPv4-mapped IPv6, and those must
// key as the IPv4 address itself, not share one /64 (::ffff:0:0/96 sits inside
// 0:0:0:0::/64, which would put every IPv4 client in one bucket).
//
// Anything that does not parse is returned unchanged, never folded into one
// constant: a shared fallback key would let one garbage value exhaust the limit
// for every other unparseable client.

const net = require('net');

function expandIPv6(addr) {
    let text = addr.toLowerCase();
    const tail = [];
    const lastColon = text.lastIndexOf(':');
    if (text.indexOf('.', lastColon) !== -1) {
        // The last 32 bits written as dotted IPv4 (::ffff:1.2.3.4). With a zone id
        // ruled out in rateKey, net.isIPv6 guarantees four decimal octets here.
        const quad = text.slice(lastColon + 1).split('.').map(Number);
        tail.push(((quad[0] << 8) | quad[1]).toString(16), ((quad[2] << 8) | quad[3]).toString(16));
        text = text.slice(0, lastColon + 1);
        if (!text.endsWith('::')) text = text.slice(0, -1);
    }
    const [head, rest] = text.split('::');
    const left = head ? head.split(':') : [];
    const right = rest === undefined ? [] : (rest ? rest.split(':') : []);
    const fill = 8 - tail.length - left.length - right.length;
    if (fill < 0) return null;
    const groups = rest === undefined
        ? [...left, ...tail]
        : [...left, ...Array(fill).fill('0'), ...right, ...tail];
    if (groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.map(g => parseInt(g, 16));
}

function rateKey(addr) {
    if (!addr) return 'unknown';
    if (typeof addr !== 'string') return addr;
    if (net.isIPv4(addr)) return addr;
    // net.isIPv6 accepts a zone id (%eth0, and %eth0.100 with a dot), which the
    // dotted-tail split above would misread and, with seven groups plus ::, throw
    // on. A real client never has one (remoteAddress drops the scope id), but
    // X-Forwarded-For is client text whenever the port is reached without the
    // proxy, so a zone is left unchanged like any other input that does not parse.
    if (addr.includes('%') || !net.isIPv6(addr)) return addr;
    const h = expandIPv6(addr);
    if (!h) return addr;
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
        return [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff].join('.');
    }
    return `${h.slice(0, 4).map(n => n.toString(16)).join(':')}::/64`;
}

module.exports = { rateKey };
