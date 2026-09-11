#!/usr/bin/env node
/** Minimal Screeps CLI runner (spike quality): node cli-run.cjs <port> <cmd1> [cmd2...]
 *  Connects to the private server CLI (TCP), sends commands sequentially with delays,
 *  dumps everything the server writes. Exits after the last command's settle delay. */
const net = require('net');
const port = parseInt(process.argv[2], 10);
const commands = process.argv.slice(3);
const DELAY_MS = 2000;
const sock = net.connect(port, '127.0.0.1');
let buf = '';
sock.on('data', d => { buf += d.toString('utf8'); });
sock.on('error', e => { console.error('CLI connection error:', e.message); process.exit(1); });
sock.on('connect', () => {
    // wait for greeting, then drip commands
    setTimeout(() => {
        let i = 0;
        const timer = setInterval(() => {
            if (i < commands.length) {
                sock.write(commands[i++] + '\n');
            } else {
                clearInterval(timer);
                setTimeout(() => {
                    process.stdout.write(buf);
                    sock.end();
                    process.exit(0);
                }, 1500);
            }
        }, DELAY_MS);
    }, 800);
});
setTimeout(() => { console.error('CLI hard timeout'); process.stdout.write(buf); process.exit(1); }, Math.max(20000, commands.length * (DELAY_MS + 1500) + 5000));
