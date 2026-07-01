import {useState, useEffect} from 'react';
import type {CSSProperties} from 'react';
import './App.css';
import {ReceiveByCode, SelectFiles, StartSend} from "../wailsjs/go/main/App";
import {EventsOn, EventsOff} from "../wailsjs/runtime/runtime";

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

function fmtBytes(n: number): string {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

function summarize(p: Prog): {pct: number; label: string} {
    const denom = p.grandTotal > 0 ? p.grandTotal : p.fileSize;
    const num = p.grandTotal > 0 ? p.totalBytes : p.fileBytes;
    const pct = denom > 0 ? Math.min(100, Math.round((num / denom) * 100)) : 0;
    const tag = p.fileCount > 1 ? `[${p.fileIndex}/${p.fileCount}] ` : '';
    return {pct, label: `${tag}${p.fileName} - ${pct}%  (${fmtBytes(num)} / ${fmtBytes(denom)})`};
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
    const [sendStatus, setSendStatus] = useState('Select files, then click Send.');
    const [sending, setSending] = useState(false);
    const [sendProg, setSendProg] = useState<{pct: number; label: string} | null>(null);

    // Receive state
    const [code, setCode] = useState('');
    const [output, setOutput] = useState('');
    const [recvStatus, setRecvStatus] = useState('Enter a code or link, then click Receive.');
    const [receiving, setReceiving] = useState(false);
    const [recvProg, setRecvProg] = useState<{pct: number; label: string} | null>(null);

    useEffect(() => {
        EventsOn('send:code', (data: {code: string; link: string}) => {
            setSendCode(data.code);
            setSendLink(data.link);
            setSendStatus('Share this code or link, then wait for the receiver to connect...');
        });
        EventsOn('send:status', (msg: string) => setSendStatus(msg));
        EventsOn('send:progress', (p: Prog) => setSendProg(summarize(p)));
        EventsOn('send:done', (msg: string) => {
            setSendStatus(msg);
            setSendProg({pct: 100, label: 'Complete.'});
            setSending(false);
        });
        EventsOn('send:error', (msg: string) => {
            setSendStatus('Error: ' + msg);
            setSending(false);
        });
        EventsOn('recv:progress', (p: Prog) => setRecvProg(summarize(p)));
        return () => {
            EventsOff('send:code');
            EventsOff('send:status');
            EventsOff('send:progress');
            EventsOff('send:done');
            EventsOff('send:error');
            EventsOff('recv:progress');
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

    async function send() {
        if (!files.length) {
            setSendStatus('Select at least one file first.');
            return;
        }
        setSending(true);
        setSendCode('');
        setSendLink('');
        setSendProg(null);
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
        setRecvStatus('Connecting... keep this window open.');
        try {
            const dir = await ReceiveByCode(code.trim(), output.trim());
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
                    <button onClick={pickFiles} disabled={sending} style={btn}>Select files...</button>
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
                    <input
                        placeholder="save to folder (blank = current dir)"
                        value={output}
                        onChange={(e) => setOutput(e.target.value)}
                        disabled={receiving}
                        autoComplete="off"
                        style={input}
                    />
                    <button onClick={receive} disabled={receiving} style={btn}>
                        {receiving ? 'Receiving...' : 'Receive'}
                    </button>
                    {recvProg && (
                        <div>
                            <Bar pct={recvProg.pct}/>
                            <div style={progLabel}>{recvProg.label}</div>
                        </div>
                    )}
                    <p style={statusStyle}>{recvStatus}</p>
                </div>
            )}
        </div>
    );
}

const appStyle: CSSProperties = {padding: 24, fontFamily: 'sans-serif', textAlign: 'center'};
const col: CSSProperties = {display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 460, margin: '0 auto'};
const input: CSSProperties = {padding: 10, fontSize: 16};
const btn: CSSProperties = {padding: 10, fontSize: 16, cursor: 'pointer'};
const statusStyle: CSSProperties = {opacity: 0.85, minHeight: 24};
const listStyle: CSSProperties = {margin: 0, paddingLeft: 18, textAlign: 'left', fontSize: 13, opacity: 0.85};
const codeStyle: CSSProperties = {fontSize: 22, fontWeight: 'bold', letterSpacing: 1};
const linkStyle: CSSProperties = {fontSize: 12, opacity: 0.7, wordBreak: 'break-all'};
const progLabel: CSSProperties = {fontSize: 12, opacity: 0.8, marginTop: 4};

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
