import {useState, useEffect} from 'react';
import type {CSSProperties} from 'react';
import './App.css';
import {ReceiveByCode, SelectFiles, StartSend} from "../wailsjs/go/main/App";
import {EventsOn, EventsOff} from "../wailsjs/runtime/runtime";

type Mode = 'send' | 'receive';

function App() {
    const [mode, setMode] = useState<Mode>('send');

    // Send state
    const [files, setFiles] = useState<string[]>([]);
    const [sendCode, setSendCode] = useState('');
    const [sendLink, setSendLink] = useState('');
    const [sendStatus, setSendStatus] = useState('Select files, then click Send.');
    const [sending, setSending] = useState(false);

    // Receive state
    const [code, setCode] = useState('');
    const [output, setOutput] = useState('');
    const [recvStatus, setRecvStatus] = useState('Enter a code or link, then click Receive.');
    const [receiving, setReceiving] = useState(false);

    useEffect(() => {
        EventsOn('send:code', (data: {code: string; link: string}) => {
            setSendCode(data.code);
            setSendLink(data.link);
            setSendStatus('Share this code or link, then wait for the receiver to connect...');
        });
        EventsOn('send:status', (msg: string) => setSendStatus(msg));
        EventsOn('send:done', (msg: string) => {
            setSendStatus(msg);
            setSending(false);
        });
        EventsOn('send:error', (msg: string) => {
            setSendStatus('Error: ' + msg);
            setSending(false);
        });
        return () => {
            EventsOff('send:code');
            EventsOff('send:status');
            EventsOff('send:done');
            EventsOff('send:error');
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
        setRecvStatus('Connecting and receiving... keep this window open.');
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
                        <ul style={{margin: 0, paddingLeft: 18, textAlign: 'left', fontSize: 13, opacity: 0.85}}>
                            {files.map((f) => <li key={f}>{f.split(/[\\/]/).pop()}</li>)}
                        </ul>
                    )}
                    <button onClick={send} disabled={sending || !files.length} style={btn}>
                        {sending ? 'Sending...' : 'Send'}
                    </button>
                    {sendCode && <div style={{fontSize: 22, fontWeight: 'bold', letterSpacing: 1}}>{sendCode}</div>}
                    {sendLink && <div style={{fontSize: 12, opacity: 0.7, wordBreak: 'break-all'}}>{sendLink}</div>}
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
