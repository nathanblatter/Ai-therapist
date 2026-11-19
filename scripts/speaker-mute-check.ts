// Headless Chromium check of the speaker mute's real audio paths
// (lib/speakerMute.ts). No server, no model, no network: the "assistant" is an
// oscillator.
//
//  1. GPT-Live: the oscillator goes through a loopback RTCPeerConnection pair
//     in the page, so the assistant arrives as a real remote WebRTC track, as
//     it does from the vendor. It plays on an <audio> element, which is then
//     muted with the app's elementSink; the app's startMixedTee taps the remote
//     stream. Expect: element muted and still playing, and the tee still
//     receiving the tone. Where the loopback cannot connect (a sandbox that
//     blocks UDP to the machine's own address), the same check runs on the
//     oscillator's local MediaStream instead, and the output says so.
//  2. Grok: the app's createPlaybackChain with an analyser standing in for the
//     speakers. Expect: silence at the speakers while muted, the tone at the
//     recording tap throughout, and the tone back at the speakers on unmute
//     with no new user gesture (the context never stops).
//
// An element's speaker output cannot be measured from inside the page, so for
// (1) "silent" means `muted === true`, which every browser honours.
//
// Usage: npx tsx scripts/speaker-mute-check.ts
// Needs the Chromium build once: npx playwright install chromium-headless-shell
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const entry = `
import { startMixedTee } from './src/client/main/lib/audioTee';
import { createPlaybackChain } from './src/client/main/lib/grokVoiceClient';
import { elementSink } from './src/client/main/lib/speakerMute';
window.__app = { startMixedTee, createPlaybackChain, elementSink };
`;

async function main() {
  const bundle = await build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020',
  });
  const code = bundle.outputFiles[0].text;

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[page]', m.text());
  });
  await page.setContent('<!doctype html><title>speaker mute check</title>');
  await page.addScriptTag({ content: code });
  // tsx compiles this file with keepNames, which wraps the functions inside
  // page.evaluate below in a __name() helper the page does not have.
  await page.addScriptTag({ content: 'window.__name = (f) => f;' });

  const result = await page.evaluate(async () => {
    type App = {
      startMixedTee: (s: MediaStream[], cb: (pcm: string, rate: number) => void) => { stop: () => void };
      createPlaybackChain: (
        ctx: AudioContext,
        speakers: AudioNode,
        muted: boolean,
      ) => { input: GainNode; record: MediaStreamAudioDestinationNode; output: GainNode };
      elementSink: (el: HTMLMediaElement) => { setMuted: (m: boolean) => void };
    };
    const app = (window as unknown as { __app: App }).__app;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const pcmRms = (b64: string) => {
      const bin = atob(b64);
      const pcm = new Int16Array(Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer);
      let sum = 0;
      for (const v of pcm) sum += (v / 0x8000) ** 2;
      return Math.sqrt(sum / pcm.length);
    };
    /** Peak tee RMS over a window: chunks arrive every ~85 ms at 48 kHz. */
    function teeMeter(streams: MediaStream[]) {
      let peak = 0;
      let chunks = 0;
      const tee = app.startMixedTee(streams, (pcm) => {
        chunks++;
        peak = Math.max(peak, pcmRms(pcm));
      });
      return {
        reset: () => {
          peak = 0;
          chunks = 0;
        },
        read: () => ({ peak, chunks }),
        stop: () => tee.stop(),
      };
    }

    // ---- 1. GPT-Live: real remote WebRTC track on an <audio> element -------
    const srcCtx = new AudioContext();
    const osc = srcCtx.createOscillator();
    osc.frequency.value = 440;
    const toPeer = srcCtx.createMediaStreamDestination();
    osc.connect(toPeer);
    osc.start();

    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    // Non-trickle: exchange each side's SDP once its candidates are gathered.
    const gathered = (pc: RTCPeerConnection) =>
      new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') resolve();
        pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve();
      });
    const remote = new Promise<MediaStream>((resolve) => {
      pc2.ontrack = (e) => resolve(e.streams[0]);
    });
    pc1.addTrack(toPeer.stream.getAudioTracks()[0], toPeer.stream);
    await pc1.setLocalDescription(await pc1.createOffer());
    await gathered(pc1);
    await pc2.setRemoteDescription(pc1.localDescription!);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await gathered(pc2);
    await pc1.setRemoteDescription(pc2.localDescription!);
    const connected = await Promise.race([
      new Promise<boolean>((resolve) => {
        if (pc2.connectionState === 'connected') resolve(true);
        pc2.onconnectionstatechange = () => pc2.connectionState === 'connected' && resolve(true);
      }),
      sleep(5000).then(() => false),
    ]);
    const remoteStream = connected ? await remote : toPeer.stream;
    const liveSource = connected ? 'remote WebRTC track (loopback)' : 'local MediaStream (loopback did not connect)';

    const el = document.createElement('audio');
    el.autoplay = true;
    el.srcObject = remoteStream;
    await el.play();
    const sink = app.elementSink(el);
    const liveTee = teeMeter([remoteStream]);
    await sleep(1500);
    const liveBefore = liveTee.read();
    sink.setMuted(true);
    liveTee.reset();
    await sleep(1500);
    const liveMuted = { ...liveTee.read(), elMuted: el.muted, elPaused: el.paused };
    sink.setMuted(false);
    liveTee.reset();
    await sleep(800);
    const liveUnmuted = { ...liveTee.read(), elMuted: el.muted, elPaused: el.paused };
    liveTee.stop();
    pc1.close();
    pc2.close();
    osc.stop();
    await srcCtx.close();

    // ---- 2. Grok: playback chain with an output gain after the record tap --
    const ctx = new AudioContext({ sampleRate: 24_000 });
    const speakers = ctx.createAnalyser();
    speakers.fftSize = 2048;
    const pull = ctx.createGain(); // keeps the analyser pulled; inaudible
    pull.gain.value = 0;
    speakers.connect(pull).connect(ctx.destination);
    const chain = app.createPlaybackChain(ctx, speakers, false);
    const tone = ctx.createOscillator();
    tone.frequency.value = 330;
    tone.connect(chain.input);
    tone.start();
    const buf = new Float32Array(speakers.fftSize);
    const speakerRms = () => {
      speakers.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      return Math.sqrt(s / buf.length);
    };
    const grokTee = teeMeter([chain.record.stream]);
    await sleep(1200);
    const grokBefore = { ...grokTee.read(), speakers: speakerRms() };
    chain.output.gain.value = 0; // GrokVoiceClient.setSpeakerMuted(true)
    grokTee.reset();
    await sleep(1200);
    const grokMuted = { ...grokTee.read(), speakers: speakerRms(), ctxState: ctx.state };
    chain.output.gain.value = 1; // setSpeakerMuted(false), no gesture
    grokTee.reset();
    await sleep(800);
    const grokUnmuted = { ...grokTee.read(), speakers: speakerRms(), ctxState: ctx.state };
    grokTee.stop();
    tone.stop();
    await ctx.close();

    return { liveSource, liveBefore, liveMuted, liveUnmuted, grokBefore, grokMuted, grokUnmuted };
  });

  await browser.close();
  console.log(JSON.stringify(result, null, 2));

  const SIGNAL = 0.05; // a full-scale sine is ~0.6 RMS after the tee's 0.85 headroom gain
  const checks: Array<[string, boolean]> = [
    ['GPT-Live: tee records the assistant before mute', result.liveBefore.peak > SIGNAL],
    ['GPT-Live: element muted while muted', result.liveMuted.elMuted === true],
    ['GPT-Live: element still playing while muted', result.liveMuted.elPaused === false],
    ['GPT-Live: tee still records the assistant while muted', result.liveMuted.peak > SIGNAL],
    [
      'GPT-Live: unmuted and playing again with no play() needed',
      !result.liveUnmuted.elMuted && !result.liveUnmuted.elPaused,
    ],
    ['GPT-Live: tee records after unmute', result.liveUnmuted.peak > SIGNAL],
    ['Grok: speakers hear the assistant before mute', result.grokBefore.speakers > SIGNAL],
    ['Grok: speakers silent while muted', result.grokMuted.speakers < 1e-4],
    ['Grok: tee still records the assistant while muted', result.grokMuted.peak > SIGNAL],
    ['Grok: context still running while muted', result.grokMuted.ctxState === 'running'],
    ['Grok: speakers hear the assistant again after unmute', result.grokUnmuted.speakers > SIGNAL],
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
