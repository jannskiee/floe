import {useState} from 'react';
import './App.css';
import {ReceiveByCode} from "../wailsjs/go/main/App";

function App() {
    const [code, setCode] = useState('');
    const [output, setOutput] = useState('');
    const [status, setStatus] = useState('Enter a code or link from a Floe sender, then click Receive.');
    const [busy, setBusy] = useState(false);

    async function receive() {
        if (!code.trim()) {
            setStatus('Please enter a code or link.');
            return;
        }
        setBusy(true);
        setStatus('Connecting and receiving... keep this window open.');
        try {
            const dir = await ReceiveByCode(code.trim(), output.trim());
            setStatus(`Done. Files saved to: ${dir}`);
        } catch (e: any) {
            setStatus(`Error: ${e}`);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div id="App" style={{padding: 24, fontFamily: 'sans-serif', textAlign: 'center'}}>
            <h1>Floe Desktop</h1>
            <p style={{opacity: 0.8, minHeight: 24}}>{status}</p>
            <div style={{display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 420, margin: '0 auto'}}>
                <input
                    placeholder="code or link (e.g. olive-tiger-castle)"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoComplete="off"
                    disabled={busy}
                    style={{padding: 10, fontSize: 16}}
                />
                <input
                    placeholder="save to folder (blank = current dir)"
                    value={output}
                    onChange={(e) => setOutput(e.target.value)}
                    autoComplete="off"
                    disabled={busy}
                    style={{padding: 10, fontSize: 16}}
                />
                <button onClick={receive} disabled={busy} style={{padding: 10, fontSize: 16}}>
                    {busy ? 'Receiving...' : 'Receive'}
                </button>
            </div>
        </div>
    );
}

export default App;
