import React, { useEffect, useState } from 'react';

interface Props {
  onDone: () => void;
}

interface Progress {
  stage: string;
  detail: string;
  progress: number | null;
}

interface Status {
  ollama: { available: boolean; models: string[] };
  voice: { ready: boolean; mode: string; detail: string };
  ocr: { ready: boolean; detail: string };
  setupComplete: boolean;
}

const DEFAULT_MODEL = 'qwen3:8b';

export default function SetupWizard({ onDone }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState(1);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const s = (await window.agent.setup.getStatus()) as Status;
    setStatus(s);
    return s;
  };

  useEffect(() => {
    refresh().catch(() => undefined);
    const off = window.agent.setup.onProgress((p) => setProgress(p as Progress));
    return off;
  }, []);

  const ollamaOk = Boolean(status?.ollama.available);
  const modelOk = Boolean(status?.ollama.models.some((m) => m === DEFAULT_MODEL || m.startsWith(`${DEFAULT_MODEL}:`)));
  const voiceOk = Boolean(status?.voice.ready);
  const ocrOk = Boolean(status?.ocr.ready);

  const run = async (fn: () => Promise<unknown>, next: () => void) => {
    setBusy(true);
    setError('');
    setProgress(null);
    try {
      await fn();
      await refresh();
      next();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const installOllama = () =>
    run(async () => {
      await window.agent.setup.installOllama();
      const ok = await window.agent.setup.waitForOllama();
      if (!ok) throw new Error('Ollama did not start. Please finish the Ollama installer and try again.');
    }, () => setStep(3));

  const pullModel = () =>
    run(() => window.agent.setup.pullModel(DEFAULT_MODEL), () => setStep(4));

  const installVoice = () =>
    run(() => window.agent.setup.installVoice(), () => setStep(5));

  const installOcr = () =>
    run(() => window.agent.setup.installOcr(), () => setStep(6));

  const finish = async () => {
    await window.agent.setup.completeSetup();
    onDone();
  };

  return (
    <div className="wizard">
      <div className="step">First-run setup</div>
      <h1>Welcome to OpenBuddy</h1>
      <p className="muted">
        This app runs entirely on your computer. It needs a local language model
        (Ollama) and, optionally, a local voice engine. Everything below is installed
        with one click each — nothing to install by hand.
      </p>

      {step === 1 && (
        <div className="card">
          <h3>Step 1 of 5 — Check Ollama</h3>
          <p>
            {status === null
              ? 'Checking…'
              : ollamaOk
                ? `Ollama is running. Installed models: ${status.ollama.models.join(', ') || 'none'}.`
                : 'Ollama is not running on this machine yet.'}
          </p>
          <div className="row">
            {ollamaOk ? (
              <button className="btn primary" onClick={() => setStep(modelOk ? 4 : 3)}>Continue</button>
            ) : (
              <button className="btn primary" disabled={busy || status === null} onClick={installOllama}>
                Download and install Ollama
              </button>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h3>Step 2 of 5 — Download the model</h3>
          <p>
            Default model: <strong>{DEFAULT_MODEL}</strong> (Qwen3 8B, 8-bit, about 8 GB).
            It fits your 12 GB graphics card. You can switch models later in Settings.
          </p>
          {progress && progress.stage === 'model' && (
            <div>
              <div className="progress"><div style={{ width: `${Math.round((progress.progress ?? 0) * 100)}%` }} /></div>
              <p className="muted">{progress.detail}</p>
            </div>
          )}
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={pullModel}>
              {modelOk ? 'Model already downloaded — continue' : `Download ${DEFAULT_MODEL}`}
            </button>
            {modelOk && <button className="btn" onClick={() => setStep(4)}>Continue</button>}
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="card">
          <h3>Step 3 of 5 — Voice engine (optional)</h3>
          <p>
            {voiceOk
              ? `Voice engine is ready (${status?.voice.detail}).`
              : 'Installs a local speech engine (faster-whisper + Piper) so you can talk to the agent and have it read replies aloud. Typed input always works without it.'}
          </p>
          {progress && progress.stage === 'voice' && <p className="muted">{progress.detail}</p>}
          <div className="row">
            {!voiceOk && (
              <button className="btn primary" disabled={busy} onClick={installVoice}>Install voice engine</button>
            )}
            <button className="btn" onClick={() => setStep(5)}>{voiceOk ? 'Continue' : 'Skip for now'}</button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="card">
          <h3>Step 4 of 5 — Attachment text recognition (optional)</h3>
          <p>
            {ocrOk
              ? `OCR language data is ready (${status?.ocr.detail}).`
              : 'Downloads the English OCR language data (about 5 MB, once) so the agent can read the text in image attachments — for example a photo of a swim schedule or a scanned school letter. Without it, Word, PDF and Excel attachments still work; only images need this.'}
          </p>
          {progress && progress.stage === 'ocr' && <p className="muted">{progress.detail}</p>}
          <div className="row">
            {!ocrOk && (
              <button className="btn primary" disabled={busy} onClick={installOcr}>Download OCR data</button>
            )}
            <button className="btn" onClick={() => setStep(6)}>{ocrOk ? 'Continue' : 'Skip for now'}</button>
          </div>
        </div>
      )}

      {step === 6 && (
        <div className="card">
          <h3>Step 5 of 5 — Done</h3>
          <p>
            Setup is complete. Connect your email accounts later in Settings
            (Email section). The agent never sends email or submits a form without
            your approval, and no data ever leaves this machine except when you
            explicitly ask it to look something up on the web.
          </p>
          <button className="btn primary" onClick={finish}>Start using OpenBuddy</button>
        </div>
      )}

      {error && <p style={{ color: '#dc2626' }}>{error}</p>}
      {busy && <p className="muted">Working… this can take a few minutes for large downloads.</p>}
    </div>
  );
}
