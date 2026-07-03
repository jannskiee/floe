import {useState, useEffect, useRef} from 'react';
import type {CSSProperties, MutableRefObject} from 'react';
import './App.css';
import {ReceiveByCode, SelectFiles, SelectFolder, OpenFolder, StartSend} from "../wailsjs/go/main/App";
import {EventsOn, EventsOff, OnFileDrop, OnFileDropOff} from "../wailsjs/runtime/runtime";

type Mode = 'send' | 'receive';

interface Prog {
    fileName: string;
    fileIndex: number;
    fileCount: number;
    fileBytes: number;
    fileSize: number;
    totalBytes: number;
    grandTotal: number;
}

type Marker = {t: number; bytes: number} | null;

function fmtBytes(n: number): string {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

function fmtSpeed(bps: number): string {
    if (!isFinite(bps) || bps <= 0) return '';
    return bps >= 1024 * 1024 ? (bps / 1048576).toFixed(1) + ' MB/s' : (bps / 1024).toFixed(0) + ' KB/s';
}

function fmtEta(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '';
    if (sec < 60) return `${Math.ceil(sec)}s`;
    return `${Math.floor(sec / 60)}m ${Math.ceil(sec % 60)}s`;
}

// track computes percent, speed, and ETA for a progress event. It uses an
// average-since-start speed (stable) keyed off a per-transfer marker ref.
function track(ref: MutableRefObject<Marker>, p: Prog): {pct: number; label: string} {
    const denom = p.grandTotal > 0 ? p.grandTotal : p.fileSize;
    const num = p.grandTotal > 0 ? p.totalBytes : p.fileBytes;
    const pct = denom > 0 ? Math.min(100, Math.round((num / denom) * 100)) : 0;

    const now = Date.now();
    if (!ref.current) ref.current = {t: now, bytes: num};
    const dt = (now - ref.current.t) / 1000;
    const speed = dt > 0.2 ? (num - ref.current.bytes) / dt : 0;
    const eta = speed > 0 ? (denom - num) / speed : Infinity;

    const tag = p.fileCount > 1 ? `[${p.fileIndex}/${p.fileCount}] ` : '';
    let label = `${tag}${p.fileName} - ${pct}%  (${fmtBytes(num)} / ${fmtBytes(denom)})`;
    const s = fmtSpeed(speed);
    const e = fmtEta(eta);
    if (s) label += `  ·  ${s}`;
    if (e && pct < 100) label += `  ·  ETA ${e}`;
    return {pct, label};
}

function Bar({pct}: {pct: number}) {
    return (
        <div style={{background: 'rgba(255,255,255,0.15)', borderRadius: 6, height: 14, overflow: 'hidden'}}>
            <div style={{width: `${pct}%`, height: '100%', background: '#4f8cff', transition: 'width 0.15s ease'}}/>
        </div>
    );
}

function App() {
    const [mode, setMode] = useState<Mode>('send');

    // Send state
    const [files, setFiles] = useState<string[]>([]);
    const [sendCode, setSendCode] = useState('');
    const [sendLink, setSendLink] = useState('');
    const [sendStatus, setSendStatus] = useState('Select or drag files, then click Send.');
    const [sending, setSending] = useState(false);
    const [sendProg, setSendProg] = useState<{pct: number; label: string} | null>(null);
    const [sendVerify, setSendVerify] = useState('');
    const sendStart = useRef<Marker>(null);

    // Receive state
    const [code, setCode] = useState('');
    const [output, setOutput] = useState('');
    const [recvStatus, setRecvStatus] = useState('Enter a code or link, then click Receive.');
    const [receiving, setReceiving] = useState(false);
    const [recvProg, setRecvProg] = useState<{pct: number; label: string} | null>(null);
    const [recvDir, setRecvDir] = useState('');
    const [recvVerify, setRecvVerify] = useState('');
    const recvStart = useRef<Marker>(null);

    useEffect(() => {
        EventsOn('send:code', (data: {code: string; link: string}) => {
            setSendCode(data.code);
            setSendLink(data.link);
            setSendStatus('Share this code or link, then wait for the receiver to connect...');
        });
        EventsOn('send:status', (msg: string) => setSendStatus(msg));
        EventsOn('send:progress', (p: Prog) => setSendProg(track(sendStart, p)));
        EventsOn('send:verify', (c: string) => setSendVerify(c));
        EventsOn('send:done', (msg: string) => {
            setSendStatus(msg);
            setSendProg({pct: 100, label: 'Complete.'});
            setSending(false);
        });
        EventsOn('send:error', (msg: string) => {
            setSendStatus('Error: ' + msg);
            setSending(false);
        });
        EventsOn('recv:progress', (p: Prog) => setRecvProg(track(recvStart, p)));
        EventsOn('recv:verify', (c: string) => setRecvVerify(c));
        // Native file drop on the whole window (useDropTarget=false, so no
        // per-element CSS is needed). Paths arrive already resolved to absolute
        // paths from the Go side.
        OnFileDrop((_x, _y, paths) => {
            if (paths && paths.length) {
                setMode('send');
                setFiles(paths);
                setSendStatus(`${paths.length} file(s) ready. Click Send.`);
            }
        }, false);
        return () => {
            EventsOff('send:code');
            EventsOff('send:status');
            EventsOff('send:progress');
            EventsOff('send:verify');
            EventsOff('send:done');
            EventsOff('send:error');
            EventsOff('recv:progress');
            EventsOff('recv:verify');
            OnFileDropOff();
        };
    }, []);

    async function pickFiles() {
        try {
            const picked = await SelectFiles();
            if (picked && picked.length) {
                setFiles(picked);
                setSendStatus(`${picked.length} file(s) ready. Click Send.`);
            }
        } catch {
            // dialog cancelled
        }
    }

    async function pickSendFolder() {
        try {
            const dir = await SelectFolder();
            if (dir) {
                setFiles([dir]);
                setSendStatus('1 folder ready. Click Send.');
            }
        } catch {
            // dialog cancelled
        }
    }

    async function pickSaveFolder() {
        try {
            const dir = await SelectFolder();
            if (dir) setOutput(dir);
        } catch {
            // dialog cancelled
        }
    }

    async function send() {
        if (!files.length) {
            setSendStatus('Select at least one file first.');
            return;
        }
        setSending(true);
        setSendCode('');
        setSendLink('');
        setSendProg(null);
        setSendVerify('');
        sendStart.current = null;
        setSendStatus('Setting up...');
        try {
            await StartSend(files);
        } catch (e: any) {
            setSendStatus('Error: ' + e);
            setSending(false);
        }
    }

    async function receive() {
        if (!code.trim()) {
            setRecvStatus('Please enter a code or link.');
            return;
        }
        setReceiving(true);
        setRecvProg(null);
        setRecvDir('');
        setRecvVerify('');
        recvStart.current = null;
        setRecvStatus('Connecting... keep this window open.');
        try {
            const dir = await ReceiveByCode(code.trim(), output.trim());
            setRecvDir(dir);
            setRecvStatus('Done. Files saved to: ' + dir);
        } catch (e: any) {
            setRecvStatus('Error: ' + e);
        } finally {
            setReceiving(false);
        }
    }

    return (
        <div id="App" style={appStyle}>
            <h1 style={{marginBottom: 4}}>Floe Desktop</h1>
            <div style={{display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 20}}>
                <button onClick={() => setMode('send')} style={tabStyle(mode === 'send')}>Send</button>
                <button onClick={() => setMode('receive')} style={tabStyle(mode === 'receive')}>Receive</button>
            </div>

            {mode === 'send' ? (
                <div style={col}>
                    <div style={{display: 'flex', gap: 8}}>
                        <button onClick={pickFiles} disabled={sending} style={{...btn, flex: 1}}>Select files...</button>
                        <button onClick={pickSendFolder} disabled={sending} style={{...btn, flex: 1}}>Select folder...</button>
                    </div>
                    <div style={{fontSize: 12, opacity: 0.6}}>or drag files onto the window</div>
                    {files.length > 0 && (
                        <ul style={listStyle}>
                            {files.map((f) => <li key={f}>{f.split(/[\\/]/).pop()}</li>)}
                        </ul>
                    )}
                    <button onClick={send} disabled={sending || !files.length} style={btn}>
                        {sending ? 'Sending...' : 'Send'}
                    </button>
                    {sendCode && <div style={codeStyle}>{sendCode}</div>}
                    {sendLink && <div style={linkStyle}>{sendLink}</div>}
                    {sendProg && (
                        <div>
                            <Bar pct={sendProg.pct}/>
                            <div style={progLabel}>{sendProg.label}</div>
                        </div>
                    )}
                    {sendVerify && <div style={verifyStyle}>Verify: <b>{sendVerify}</b> · confirm it matches the receiver</div>}
                    <p style={statusStyle}>{sendStatus}</p>
                </div>
            ) : (
                <div style={col}>
                    <input
                        placeholder="code or link (e.g. olive-tiger-castle)"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        disabled={receiving}
                        autoComplete="off"
                        style={input}
                    />
                    <div style={{display: 'flex', gap: 8}}>
                        <input
                            placeholder="save to folder (blank = Downloads)"
                            value={output}
                            onChange={(e) => setOutput(e.target.value)}
                            disabled={receiving}
                            autoComplete="off"
                            style={{...input, flex: 1}}
                        />
                        <button onClick={pickSaveFolder} disabled={receiving} style={btn}>Browse...</button>
                    </div>
                    <button onClick={receive} disabled={receiving} style={btn}>
                        {receiving ? 'Receiving...' : 'Receive'}
                    </button>
                    {recvProg && (
                        <div>
                            <Bar pct={recvProg.pct}/>
                            <div style={progLabel}>{recvProg.label}</div>
                        </div>
                    )}
                    {recvVerify && <div style={verifyStyle}>Verify: <b>{recvVerify}</b> · confirm it matches the sender</div>}
                    {recvDir && !receiving && (
                        <button onClick={() => { OpenFolder(recvDir).catch(() => {}); }} style={btn}>Show in folder</button>
                    )}
                    <p style={statusStyle}>{recvStatus}</p>
                </div>
            )}
        </div>
    );
}

const appStyle: CSSProperties = {padding: 24, fontFamily: 'sans-serif', textAlign: 'center', minHeight: '100vh', boxSizing: 'border-box'};
const col: CSSProperties = {display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 460, margin: '0 auto'};
const input: CSSProperties = {padding: 10, fontSize: 16};
const btn: CSSProperties = {padding: 10, fontSize: 16, cursor: 'pointer'};
const statusStyle: CSSProperties = {opacity: 0.85, minHeight: 24};
const listStyle: CSSProperties = {margin: 0, paddingLeft: 18, textAlign: 'left', fontSize: 13, opacity: 0.85};
const codeStyle: CSSProperties = {fontSize: 22, fontWeight: 'bold', letterSpacing: 1};
const linkStyle: CSSProperties = {fontSize: 12, opacity: 0.7, wordBreak: 'break-all'};
const progLabel: CSSProperties = {fontSize: 12, opacity: 0.8, marginTop: 4};
const verifyStyle: CSSProperties = {fontSize: 13, opacity: 0.9, background: 'rgba(255,255,255,0.08)', borderRadius: 6, padding: '6px 8px'};

function tabStyle(active: boolean): CSSProperties {
    return {
        padding: '8px 20px',
        fontSize: 16,
        cursor: 'pointer',
        fontWeight: active ? 'bold' : 'normal',
        opacity: active ? 1 : 0.6,
    };
}

export default App;
